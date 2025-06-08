import { client } from "@gradio/client";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";
import fetch from "node-fetch";
import { Blob } from "buffer";

const fetchDropdowns = async () => {
    try {
        const app = await client("https://e964705c1f756449c9.gradio.live/");
        const result = await app.predict("/change_choices", []);

        // 返回两个下拉列表的选项
        const [sovitsWeights, gptWeights] = result.data;
        console.log("SoVITS weights:", sovitsWeights);
        console.log("GPT weights:", gptWeights);

        return { sovitsWeights, gptWeights };
    } catch (error) {
        console.error("Error fetching dropdowns:", error);
    }
};

// 获取当前模块路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 路径配置
const config = {
    inputDir: path.join(__dirname, "./reference"), // 参考音频目录
    outputDir: path.join(__dirname, "./inference"), // 输出目录
    inputFile: "1.m4a_0002330240_0002470720.wav", // 输入文件名
};

// console.log("__filename", __filename, __dirname, config);

async function generateAndSaveTTS() {
    try {
        // 确保输出目录存在
        await fs.mkdir(config.outputDir, { recursive: true });

        const audioPath = path.join(config.inputDir, config.inputFile);
        // 读取本地音频文件
        const audioData = await readFile(audioPath);
        const exampleAudio = new Blob([audioData], { type: "audio/wav" });

        const params = [
            exampleAudio,
            "知道太多会被杀掉。有的野猫，可是有狩猎乌鸦的胆量的。", // 参考文本
            "Chinese", // 参考音频语言
            "what what", // 推理文本
            "English", // 推理语言
            "No slice", // 句子切分方式
            15, // top_k
            1, // top_p
            1, // temperature
            false, // 无参考文本模式
            1, // 语速
            false, // 语音稳定性
            null, // 多参考文件占位符
            "4", // 采样步数
        ];

        // 3. 初始化Gradio客户端
        const app = await client("https://e964705c1f756449c9.gradio.live");

        // 4. 调用API
        const result = await app.predict("/get_tts_wav", params);

        console.log("result", result);

        // 5. 保存音频文件
        const audioUrl = result.data[0].url;
        const outputPath = path.join(
            config.outputDir,
            `output_${Date.now()}.wav` // 自定义文件名
        );

        const response = await fetch(audioUrl);
        const buffer = await response.buffer();
        await fs.writeFile(outputPath, buffer);
        console.log(`✅ 音频已保存至：${outputPath}`);

        return outputPath;
    } catch (error) {
        console.error("❌ 生成失败：", error);
        process.exit(1);
    }
}

const changeModels = async () => {
    try {
        const app = await client("https://e964705c1f756449c9.gradio.live/");
        const result1 = await app.predict("/change_sovits_weights", [
            "SoVITS_weights_v2/xxx_e12_s96.pth", // string  in 'SoVITS weight list' Dropdown component
            "Chinese", // string  in 'Language for reference audio' Dropdown component
            "Chinese", // string  in 'Inference text languageLess Multilingual is better' Dropdown component
        ]);

        // console.log(result1.data);

        const result2 = await app.predict("/change_gpt_weights", [
            "GPT_weights_v2/xxx-e15.ckpt", // string  in 'GPT weight list' Dropdown component
        ]);
        // console.log(result2.data);
    } catch (error) {
        console.error("Error changeModels:", error);
    }
};



// change_choices调用示例
// fetchDropdowns();

changeModels();
// 执行生成
generateAndSaveTTS();
