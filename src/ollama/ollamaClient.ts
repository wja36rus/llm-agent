import { Ollama } from "ollama";

export class OllamaClient {
  private ollama: Ollama;
  private model: string;

  constructor(model: string = "qwen2.5-coder:7b") {
    this.ollama = new Ollama({ host: "http://localhost:11434" });
    this.model = model;
  }

  async generate(prompt: string): Promise<string> {
    try {
      console.log(`🤖 Generating test with ${this.model}...`);

      const response = await this.ollama.generate({
        model: this.model,
        prompt: prompt,
        options: {
          temperature: 0.2, // Низкая температура для более точных ответов
          top_p: 0.9,
          top_k: 40,
          num_predict: 2000, // Максимальная длина ответа
        },
      });

      return response.response;
    } catch (error) {
      console.error("Error generating with Ollama:", error);
      throw error;
    }
  }

  async listModels(): Promise<string[]> {
    const models = await this.ollama.list();

    return models.models.map((m) => m.name);
  }
}
