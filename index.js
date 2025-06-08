import { client } from "@gradio/client";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { Blob } from "buffer";
import csv from "csv-parser";
import wav from "wav";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置参数
const config = {
    inputDir: path.join(__dirname, "./reference"),
    outputDir: path.join(__dirname, "./vocabulary_audio"),
    inputFile: "1.m4a_0002330240_0002470720.wav",
    wordsFile: path.join(__dirname, "words.csv"),
    sovitsWeight: "SoVITS_weights_v2/xxx_e12_s96.pth",
    gptWeight: "GPT_weights_v2/xxx-e15.ckpt",
    refText: "知道太多会被杀掉。有的野猫，可是有狩猎乌鸦的胆量的。",
    refLang: "Chinese",
    iterations: 3, // 每个单词生成次数
    // 间隔时间（秒）
    pauses: {
        betweenEnglish: 0.3, // 英文两遍之间的间隔
        betweenEnZh: 0.5, // 英文和中文之间的间隔
        betweenWords: 1.0, // 单词之间的间隔
    },
    // 音频格式参数
    audioFormat: {
        sampleRate: 32000,
        channels: 1,
        bitDepth: 16,
    },
};

// 读取单词文件
async function loadWords() {
    return new Promise((resolve, reject) => {
        const words = [];
        fs.createReadStream(config.wordsFile)
            .pipe(csv({ separator: "|" }))
            .on("data", (data) => words.push(data))
            .on("end", () => resolve(words))
            .on("error", reject);
    });
}

// 生成TTS音频
async function generateTTS(
    exampleAudio,
    text,
    language,
    sliceMethod,
    outputPath
) {
    const app = await client("https://ea668b696d7dca25ce.gradio.live");

    const params = [
        exampleAudio,
        config.refText,
        config.refLang,
        text,
        language,
        sliceMethod,
        15,
        1,
        1,
        false,
        1,
        false,
        null,
        4,
    ];

    const result = await app.predict("/get_tts_wav", params);
    const audioUrl = result.data[0].url;

    const response = await fetch(audioUrl);
    const buffer = await response.buffer();
    await fs.promises.writeFile(outputPath, buffer);

    return outputPath;
}

// 生成单词音频（每个部分单独生成）
async function generateWordAudio(wordData) {
    const word = wordData.word;
    const meaning = wordData.meaning;

    // 创建单词目录
    const wordDir = path.join(config.outputDir, word);
    await fs.promises.mkdir(wordDir, { recursive: true });

    // 读取参考音频
    const audioPath = path.join(config.inputDir, config.inputFile);
    const audioData = await fs.promises.readFile(audioPath);
    const exampleAudio = new Blob([audioData], { type: "audio/wav" });

    // 生成3个版本
    for (let i = 1; i <= config.iterations; i++) {
        const versionDir = path.join(wordDir, `version_${i}`);
        await fs.promises.mkdir(versionDir, { recursive: true });

        console.log(`生成中: ${word} 版本 ${i}`);

        // 英文部分（只生成一遍）
        const enPath = path.join(versionDir, `${word}_en.wav`);
        await generateTTS(
            exampleAudio,
            word,
            "English",
            "No slice",
            enPath
        );

        // 中文部分（单独生成）
        const zhPath = path.join(versionDir, `${word}_zh.wav`);
        await generateTTS(exampleAudio, meaning, "Chinese", "No slice", zhPath);

        console.log(`✅ 完成: ${word} 版本 ${i}`);
    }

    return wordDir;
}

// 创建静音片段（纯Node.js实现）
function createSilenceBuffer(durationSeconds) {
    const bytesPerSample = config.audioFormat.bitDepth / 8;
    const numSamples = Math.floor(
        durationSeconds * config.audioFormat.sampleRate
    );
    const bufferSize = numSamples * bytesPerSample * config.audioFormat.channels;

    // 创建全零缓冲区（静音）
    return Buffer.alloc(bufferSize);
}

// 拼接音频文件（带间隔）- 完全Node.js实现
async function concatWithPauses(files, pauses, outputPath) {
    const writer = new wav.FileWriter(outputPath, {
        channels: config.audioFormat.channels,
        sampleRate: config.audioFormat.sampleRate,
        bitDepth: config.audioFormat.bitDepth,
    });

    // 创建静音缓冲区
    const betweenEnSilence = createSilenceBuffer(pauses.betweenEnglish);
    const betweenEnZhSilence = createSilenceBuffer(pauses.betweenEnZh);
    const betweenWordsSilence = createSilenceBuffer(pauses.betweenWords);

    for (let i = 0; i < files.length; i++) {
        const fileGroup = files[i];

        // 读取英文音频
        const enBuffer = await fs.promises.readFile(fileGroup.en);
        // 读取中文音频
        const zhBuffer = await fs.promises.readFile(fileGroup.zh);

        // 写入英文第一遍
        writer.write(enBuffer);

        // 写入英文之间的静音
        writer.write(betweenEnSilence);

        // 写入英文第二遍（同一文件）
        writer.write(enBuffer);

        // 写入英文和中文之间的静音
        writer.write(betweenEnZhSilence);

        // 写入中文
        writer.write(zhBuffer);

        // 写入单词之间的静音（最后一个单词不加）
        if (i < files.length - 1) {
            writer.write(betweenWordsSilence);
        }
    }

    // 关闭写入流
    return new Promise((resolve) => {
        writer.end(() => {
            resolve(outputPath);
        });
    });
}

// 主执行函数
async function main() {
    try {
        // 确保目录存在
        await fs.promises.mkdir(config.outputDir, { recursive: true });

        // 加载单词
        const words = await loadWords();
        console.log(`加载单词: ${words.length}个`);

        // 设置模型
        const app = await client("https://ea668b696d7dca25ce.gradio.live/");
        await app.predict("/change_sovits_weights", [
            config.sovitsWeight,
            config.refLang,
            "English",
        ]);
        await app.predict("/change_gpt_weights", [config.gptWeight]);

        // 生成所有单词音频
        for (const wordData of words) {
            await generateWordAudio(wordData);
        }

        console.log("✅ 所有单词音频生成完成");

        // 拼接示例（使用每个单词的第一个版本）
        const filesToConcat = [];
        for (const wordData of words) {
            const word = wordData.word;
            // 使用每个单词的第一个版本
            const versionDir = path.join(config.outputDir, word, "version_1");
            filesToConcat.push({
                en: path.join(versionDir, `${word}_en.wav`),
                zh: path.join(versionDir, `${word}_zh.wav`),
            });
        }

        const outputPath = path.join(
            config.outputDir,
            "full_vocabulary_with_pauses.wav"
        );
        await concatWithPauses(filesToConcat, config.pauses, outputPath);
        console.log(`✅ 完整音频已生成: ${outputPath}`);
    } catch (error) {
        console.error("❌ 执行出错:", error);
        process.exit(1);
    }
}

// 执行主函数
main();
