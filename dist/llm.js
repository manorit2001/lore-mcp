import { fetch } from "undici";
export class LLMClient {
    cfg;
    constructor(cfg = {}) {
        const envProvider = (process.env.LLM_PROVIDER || "").toLowerCase();
        let provider = envProvider || cfg.provider;
        if (!provider) {
            if (process.env.ANTHROPIC_API_KEY)
                provider = "anthropic";
            else if (process.env.OPENAI_API_KEY)
                provider = "openai";
            else if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
                provider = "google";
            else if (process.env.LITELLM_BASE_URL || process.env.LITELLM_API_KEY)
                provider = "litellm";
            else if (process.env.OLLAMA_URL || process.env.OLLAMA_HOST)
                provider = "ollama";
            else if (process.env.LLM_CMD)
                provider = "command";
            else
                provider = "command";
        }
        const defaultModel = cfg.model
            || process.env.LLM_MODEL
            || (provider === "anthropic" ? "claude-3-5-sonnet-20240620" : provider === "ollama" ? "llama3.1:8b-instruct" : provider === "google" ? "gemini-1.5-flash" : "gpt-4o-mini");
        const apiKey = cfg.apiKey
            || (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY
                : provider === "openai" ? process.env.OPENAI_API_KEY
                    : provider === "google" ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
                        : provider === "litellm" ? process.env.LITELLM_API_KEY
                            : "");
        // conservative defaults; can be overridden via env/args
        const contextTokens = Number(cfg.contextTokens || process.env.LLM_CONTEXT_TOKENS || (provider === "anthropic" ? 200_000 : 128_000));
        const maxOutputTokens = Number(cfg.maxOutputTokens || process.env.LLM_MAX_OUTPUT_TOKENS || 1200);
        const temperature = Number(cfg.temperature || process.env.LLM_TEMPERATURE || 0.2);
        const baseUrlEnv = provider === "litellm"
            ? (process.env.LITELLM_BASE_URL || process.env.LLM_BASE_URL || "")
            : (process.env.LLM_BASE_URL || "");
        const baseUrl = cfg.baseUrl || baseUrlEnv;
        const ollamaUrl = cfg.ollamaUrl || process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
        const command = cfg.command || process.env.LLM_CMD || "";
        this.cfg = { provider, model: defaultModel, apiKey, baseUrl, temperature, maxOutputTokens, contextTokens, ollamaUrl, command };
    }
    get config() { return this.cfg; }
    async complete(messages) {
        switch (this.cfg.provider) {
            case "openai":
                if (!this.cfg.apiKey)
                    throw new Error("OPENAI_API_KEY is not set.");
                return this.completeOpenAI(messages);
            case "anthropic":
                if (!this.cfg.apiKey)
                    throw new Error("ANTHROPIC_API_KEY is not set.");
                return this.completeAnthropic(messages);
            case "google":
                if (!this.cfg.apiKey)
                    throw new Error("GEMINI_API_KEY/GOOGLE_API_KEY is not set.");
                return this.completeGoogle(messages);
            case "ollama":
                return this.completeOllama(messages);
            case "command":
                return this.completeCommand(messages);
            case "mock":
                return this.completeMock(messages);
            case "litellm":
                return this.completeLitellm(messages);
            default:
                throw new Error(`Unsupported provider: ${this.cfg.provider}`);
        }
    }
    async completeGoogle(messages) {
        // Gemini API v1beta generateContent
        // Docs: https://ai.google.dev/api/rest/v1beta/models
        const base = (this.cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/?$/, "");
        const model = encodeURIComponent(this.cfg.model);
        const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(this.cfg.apiKey)}`;
        const systemText = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
        const nonSystem = messages.filter(m => m.role !== "system");
        const contents = nonSystem.map(m => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }]
        }));
        const body = {
            contents,
            systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
            generationConfig: {
                temperature: this.cfg.temperature,
                maxOutputTokens: this.cfg.maxOutputTokens,
            }
        };
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const text = await safeText(res);
            throw new Error(`Gemini API error ${res.status}: ${text}`);
        }
        const data = await res.json();
        const cand = data.candidates?.[0];
        const parts = cand?.content?.parts || cand?.output || [];
        const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("") : (typeof parts === "string" ? parts : "");
        const usage = data.usage || data.promptFeedback || undefined;
        return { text, model: this.cfg.model, usage };
    }
    async completeOpenAI(messages) {
        const url = this.cfg.baseUrl || "https://api.openai.com/v1/chat/completions";
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "authorization": `Bearer ${this.cfg.apiKey}`,
            },
            body: JSON.stringify({
                model: this.cfg.model,
                messages,
                temperature: this.cfg.temperature,
                max_tokens: this.cfg.maxOutputTokens,
            })
        });
        if (!res.ok) {
            const text = await safeText(res);
            throw new Error(`OpenAI API error ${res.status}: ${text}`);
        }
        const data = await res.json();
        const choice = data.choices?.[0]?.message?.content || "";
        return {
            text: choice,
            model: data.model,
            usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens }
        };
    }
    async completeAnthropic(messages) {
        const url = this.cfg.baseUrl || "https://api.anthropic.com/v1/messages";
        const systemParts = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
        const userAssistant = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": this.cfg.apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: this.cfg.model,
                max_tokens: this.cfg.maxOutputTokens,
                temperature: this.cfg.temperature,
                system: systemParts || undefined,
                messages: userAssistant,
            })
        });
        if (!res.ok) {
            const text = await safeText(res);
            throw new Error(`Anthropic API error ${res.status}: ${text}`);
        }
        const data = await res.json();
        const content = data?.content?.[0]?.text || "";
        return {
            text: content,
            model: data.model,
            usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens }
        };
    }
    async completeMock(messages) {
        const user = messages.filter(m => m.role === "user").map(m => m.content).join("\n\n");
        const reduced = /PARTIALS:/i.test(user);
        const payload = process.env.LLM_MOCK_TEXT || JSON.stringify({
            overview: reduced ? "reduced" : "ok",
            key_points: reduced ? ["kp"] : ["a"],
            decisions: [],
            open_questions: [],
            action_items: [],
            version_notes: []
        });
        return { text: payload, model: "mock" };
    }
    renderTextPrompt(messages) {
        const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
        const convo = messages.filter(m => m.role !== "system").map(m => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
        return (sys ? `SYSTEM:\n${sys}\n\n` : "") + convo + "\n";
    }
    async completeOllama(messages) {
        // Prefer chat endpoint to preserve roles
        const url = `${this.cfg.ollamaUrl.replace(/\/?$/, "")}/api/chat`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: this.cfg.model,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
                options: {
                    temperature: this.cfg.temperature,
                    num_ctx: this.cfg.contextTokens,
                    num_predict: this.cfg.maxOutputTokens,
                },
                stream: false,
            })
        });
        if (!res.ok) {
            const text = await safeText(res);
            throw new Error(`Ollama error ${res.status}: ${text}`);
        }
        const data = await res.json();
        const text = data?.message?.content || data?.response || "";
        return { text, model: this.cfg.model };
    }
    async completeCommand(messages) {
        const cmd = this.cfg.command;
        if (!cmd)
            throw new Error("LLM_CMD is not set. Provide a shell command that reads prompt from stdin and writes summary to stdout.");
        const prompt = this.renderTextPrompt(messages);
        const { spawn } = await import("node:child_process");
        const child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        const exit = new Promise((resolve, reject) => {
            child.on("error", (e) => reject(e));
            child.on("close", (code) => {
                if (code !== 0)
                    return reject(new Error(stderr || `command exited with code ${code}`));
                resolve();
            });
        });
        child.stdin.write(prompt);
        child.stdin.end();
        await exit;
        return { text: stdout.trim(), model: `command:${cmd}` };
    }
    async completeLitellm(messages) {
        const base = (this.cfg.baseUrl || process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000").replace(/\/?$/, "");
        const url = `${base}/v1/chat/completions`;
        const headers = { "content-type": "application/json" };
        if (this.cfg.apiKey)
            headers["authorization"] = `Bearer ${this.cfg.apiKey}`;
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: this.cfg.model,
                messages,
                temperature: this.cfg.temperature,
                max_tokens: this.cfg.maxOutputTokens,
                stream: false,
            })
        });
        if (!res.ok) {
            const text = await safeText(res);
            throw new Error(`LiteLLM error ${res.status}: ${text}`);
        }
        const data = await res.json();
        const choice = data.choices?.[0];
        const content = choice?.message?.content || choice?.text || "";
        const usage = data.usage || undefined;
        return {
            text: content,
            model: data.model || this.cfg.model,
            usage: {
                inputTokens: usage?.prompt_tokens ?? usage?.input_tokens,
                outputTokens: usage?.completion_tokens ?? usage?.output_tokens,
            }
        };
    }
}
async function safeText(res) {
    try {
        return await res.text();
    }
    catch {
        return "<no body>";
    }
}
