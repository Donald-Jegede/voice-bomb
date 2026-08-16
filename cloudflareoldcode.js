/* 

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
    return new Response(
        JSON.stringify(data),
        {
            status,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            }
        }
    );
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        if (request.method === "GET") {
            return json({
                ok: true,
                message: "Word Bomb voice Worker is running."
            });
        }

        if (request.method !== "POST") {
            return json({
                error: "POST an audio recording to this Worker."
            }, 405);
        }

        try {
            if (!env.GROQ_API_KEY) {
                return json({
                    error:
                        "GROQ_API_KEY is missing from the Worker secrets."
                }, 500);
            }

            const incoming = await request.formData();

            const file = incoming.get("file");

            if (!file || !(file instanceof File)) {
                return json({
                    error: "No audio file was received."
                }, 400);
            }

            if (file.size === 0) {
                return json({
                    error: "The audio file is empty."
                }, 400);
            }

            if (file.size > 25 * 1024 * 1024) {
                return json({
                    error: "The audio file is too large."
                }, 400);
            }

            const groqForm = new FormData();

            groqForm.append(
                "file",
                file,
                file.name || "word.webm"
            );

            groqForm.append(
                "model",
                "whisper-large-v3-turbo"
            );

            groqForm.append(
                "language",
                "en"
            );

            groqForm.append(
                "response_format",
                "json"
            );

            groqForm.append(
                "temperature",
                "0"
            );

            groqForm.append(
                "prompt",
                "The speaker is saying exactly one English word for a word game. Return only the spoken word in lowercase. Do not add punctuation, explanations, or extra words."
            );

            const groqResponse = await fetch(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                {
                    method: "POST",
                    headers: {
                        "Authorization":
                            `Bearer ${env.GROQ_API_KEY}`
                    },
                    body: groqForm
                }
            );

            const raw = await groqResponse.text();

            let result;

            try {
                result = JSON.parse(raw);
            } catch {
                result = {
                    raw
                };
            }

            if (!groqResponse.ok) {
                return json({
                    error:
                        result?.error?.message ||
                        "Groq rejected the recording.",
                    groqStatus:
                        groqResponse.status
                }, groqResponse.status);
            }

            return json({
                success: true,
                text: result.text || ""
            });

        } catch (error) {
            return json({
                error:
                    error?.message ||
                    "Unknown Worker error."
            }, 500);
        }
    }
};
*/