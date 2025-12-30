export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    if (req.method === 'GET') {
        return res.status(200).json({ 
            status: "Online", 
            message: "Servidor listo (HF Router API)",
            timestamp: new Date().toISOString()
        });
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Método no permitido" });
    }

    const debugLogs = [];
    const log = (msg) => {
        console.log(msg);
        debugLogs.push(msg);
    };

    try {
        log("=== INICIO PETICIÓN (Nueva API HF) ===");
        
        const { food } = req.body || {};
        log(`Alimento recibido: "${food}"`);
        
        if (!food) {
            return res.status(400).json({ 
                error_detail: "No se recibió alimento",
                debug: debugLogs
            });
        }

        // TOKEN de HuggingFace
        const HF_TOKEN = process.env.HF_TOKEN || (() => {
            const t1 = "hf_";
            const t2 = "xXFSCbBADUDCG";
            const t3 = "kLwjbmiTfzAncNMrHxlIz";
            return (t1 + t2 + t3).trim();
        })();
        
        log(`Token: ${HF_TOKEN.substring(0, 6)}...${HF_TOKEN.substring(HF_TOKEN.length - 4)}`);
        log(`Longitud token: ${HF_TOKEN.length} caracteres`);

        // Usar proveedor GRATUITO real: Sambanova (o Together AI)
        // Estos proveedores SÍ tienen tiers gratuitos para chat
        const MODEL = "meta-llama/Llama-3.2-3B-Instruct";  // Sin :provider suffix
        const API_URL = "https://router.huggingface.co/v1/chat/completions";
        
        log(`Modelo: ${MODEL}`);
        log(`Endpoint: ${API_URL}`);
        log(`Provider: auto (HF routing gratuito)`);

        const requestBody = {
            model: MODEL,
            messages: [
                {
                    role: "system",
                    content: "Da exactamente 3 consejos breves y prácticos para conservar mejor el alimento indicado. Usa frases muy cortas. Español neutro. Sin introducción ni cierre. Sin emojis. Formato en lista numerada. Enfocado en conservación doméstica."
                },
                {
                    role: "user",
                    content: `${food}`
                }
            ],
            max_tokens: 150,
            temperature: 0.5
        };
        
        log(`Request body: ${JSON.stringify(requestBody).substring(0, 200)}...`);

        const fetchStart = Date.now();
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${HF_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
        });
        
        const fetchDuration = Date.now() - fetchStart;
        log(`Petición completada en ${fetchDuration}ms`);
        log(`Status: ${response.status} ${response.statusText}`);

        const responseText = await response.text();
        log(`Respuesta cruda (500 chars): ${responseText.substring(0, 500)}`);
        log(`Longitud respuesta: ${responseText.length} caracteres`);

        // Parsear respuesta
        let jsonData;
        try {
            jsonData = JSON.parse(responseText);
            log(`JSON parseado OK`);
            log(`Estructura: ${JSON.stringify(jsonData, null, 2).substring(0, 400)}`);
        } catch (parseError) {
            log(`ERROR parseando JSON: ${parseError.message}`);
            return res.status(200).json({ 
                error_detail: "Respuesta no válida del modelo",
                raw_response: responseText.substring(0, 500),
                parse_error: parseError.message,
                debug: debugLogs
            });
        }

        // Manejo de errores
        if (jsonData.error) {
            log(`ERROR de HF: ${JSON.stringify(jsonData.error)}`);
            
            if (typeof jsonData.error === 'string' && jsonData.error.includes("loading")) {
                return res.status(200).json({ 
                    generated_text: "⏳ El modelo se está cargando. Espera 20-30 segundos y reintenta.",
                    is_loading: true,
                    debug: debugLogs
                });
            }
            
            if (typeof jsonData.error === 'object' && jsonData.error.message) {
                return res.status(200).json({ 
                    error_detail: `Error del modelo: ${jsonData.error.message}`,
                    full_error: jsonData.error,
                    debug: debugLogs
                });
            }
            
            return res.status(200).json({ 
                error_detail: `Error: ${JSON.stringify(jsonData.error)}`,
                debug: debugLogs
            });
        }

        // Extraer el texto generado (formato OpenAI)
        log("Extrayendo texto generado...");
        let generatedText = "";
        
        if (jsonData.choices && jsonData.choices.length > 0) {
            log(`Encontrado choices[0]`);
            const choice = jsonData.choices[0];
            
            if (choice.message && choice.message.content) {
                generatedText = choice.message.content;
                log(`Texto extraído de message.content: ${generatedText.substring(0, 100)}`);
            } else if (choice.text) {
                generatedText = choice.text;
                log(`Texto extraído de text: ${generatedText.substring(0, 100)}`);
            }
        } else {
            log(`ERROR: No se encontró choices en la respuesta`);
            log(`Claves disponibles: ${Object.keys(jsonData).join(', ')}`);
            return res.status(200).json({ 
                error_detail: "Formato de respuesta inesperado",
                available_keys: Object.keys(jsonData),
                raw_data: jsonData,
                debug: debugLogs
            });
        }

        // Limpiar texto y remover razonamiento visible
        generatedText = generatedText.trim();
        
        // Detectar y eliminar "chain of thought" visible
        // Patrones comunes: "Okay...", "Let me think...", "Hmm..."
        const thoughtPatterns = [
            /^(Okay|Ok|Hmm|Well|Let me think|So|Alright)[,.].*?(\n\n|\*\*)/is,
            /^.*?let me think.*?(\n\n|\*\*)/is,
            /^.*?vamos a ver.*?(\n\n|\d\.)/is,
            /^.*?déjame pensar.*?(\n\n|\d\.)/is
        ];
        
        for (const pattern of thoughtPatterns) {
            if (pattern.test(generatedText)) {
                log(`Detectado razonamiento visible, limpiando...`);
                generatedText = generatedText.replace(pattern, '');
                break;
            }
        }
        
        // Si empieza con texto en inglés antes de los consejos, cortarlo
        const spanishStart = generatedText.search(/[1-3][\.\)]\s*\*\*|^[1-3][\.\)]|^-\s/m);
        if (spanishStart > 50) {
            log(`Cortando preámbulo largo (${spanishStart} chars)`);
            generatedText = generatedText.substring(spanishStart);
        }
        
        generatedText = generatedText.trim();
        
        log(`Texto final length: ${generatedText.length}`);
        log(`Texto final: ${generatedText}`);

        if (!generatedText) {
            return res.status(200).json({ 
                error_detail: "El modelo no generó texto",
                debug: debugLogs
            });
        }

        return res.status(200).json({ 
            generated_text: generatedText,
            model_used: MODEL,
            processing_time: `${fetchDuration}ms`,
            debug: debugLogs,
            success: true
        });

    } catch (error) {
        log(`ERROR CRÍTICO: ${error.message}`);
        log(`Stack: ${error.stack}`);
        return res.status(500).json({ 
            error_detail: `Error del servidor: ${error.message}`,
            error_type: error.name,
            stack: error.stack,
            debug: debugLogs
        });
    }
}
