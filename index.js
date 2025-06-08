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
    iterations: 2,
    pauses: {
        betweenEnglish: 0.3,
        betweenEnZh: 0.5,
        betweenWords: 1.0,
    },
    // 确保所有音频使用统一格式
    audioFormat: {
        sampleRate: 32000,
        channels: 1,
        bitDepth: 16,
        // 移除了 format 属性，因为它不是必需的
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

// 生成单词音频
async function generateWordAudio(wordData) {
    const word = wordData.word;
    const meaning = wordData.meaning;

    const wordDir = path.join(config.outputDir, word);
    await fs.promises.mkdir(wordDir, { recursive: true });

    const audioPath = path.join(config.inputDir, config.inputFile);
    const audioData = await fs.promises.readFile(audioPath);
    const exampleAudio = new Blob([audioData], { type: "audio/wav" });

    for (let i = 1; i <= config.iterations; i++) {
        const versionDir = path.join(wordDir, `version_${i}`);
        await fs.promises.mkdir(versionDir, { recursive: true });

        console.log(`生成中: ${word} 版本 ${i}`);

        // 英文部分
        const enPath = path.join(versionDir, `${word}_en.wav`);
        await generateTTS(
            exampleAudio,
            word,
            "English",
            "No slice",
            enPath
        );

        // 中文部分
        const zhPath = path.join(versionDir, `${word}_zh.wav`);
        await generateTTS(exampleAudio, meaning, "Chinese", "No slice", zhPath);

        console.log(`✅ 完成: ${word} 版本 ${i}`);
    }

    return wordDir;
}

// 读取WAV文件并提取PCM数据
function readWavFile(filePath) {
    return new Promise((resolve, reject) => {
        const reader = fs.createReadStream(filePath);
        const wavReader = new wav.Reader();

        wavReader.on("format", (format) => {
            const chunks = [];
            wavReader.on("data", (data) => chunks.push(data));
            wavReader.on("end", () => {
                resolve({
                    data: Buffer.concat(chunks),
                    format: format,
                });
            });
        });

        wavReader.on("error", reject);
        reader.pipe(wavReader);
    });
}

// 创建正确的静音片段
function createSilenceBuffer(format, durationSeconds) {
    const bytesPerSample = format.bitDepth / 8;
    const numSamples = Math.floor(durationSeconds * format.sampleRate);
    const bufferSize = numSamples * bytesPerSample * format.channels;

    return Buffer.alloc(bufferSize);
}

// 改进的音频拼接
async function concatWithPauses(files, pauses, outputPath) {
    return new Promise(async (resolve, reject) => {
        // 先读取一个文件获取格式信息
        const sampleFile = await readWavFile(files[0].en);
        const format = sampleFile.format;

        const writer = new wav.FileWriter(outputPath, {
            channels: format.channels,
            sampleRate: format.sampleRate,
            bitDepth: format.bitDepth,
        });

        // 为所有文件创建静音缓冲区
        const betweenEnSilence = createSilenceBuffer(format, pauses.betweenEnglish);
        const betweenEnZhSilence = createSilenceBuffer(format, pauses.betweenEnZh);
        const betweenWordsSilence = createSilenceBuffer(
            format,
            pauses.betweenWords
        );

        let currentIndex = 0;

        const processNext = async () => {
            if (currentIndex >= files.length) {
                writer.end();
                resolve(outputPath);
                return;
            }

            try {
                const fileGroup = files[currentIndex];

                // 读取英文音频
                const enData = await readWavFile(fileGroup.en);
                // 读取中文音频
                const zhData = await readWavFile(fileGroup.zh);

                // 写入英文第一遍
                writer.write(enData.data);

                // 写入英文之间的静音
                writer.write(betweenEnSilence);

                // 写入英文第二遍
                writer.write(enData.data);

                // 写入英文和中文之间的静音
                writer.write(betweenEnZhSilence);

                // 写入中文
                writer.write(zhData.data);

                // 写入单词之间的静音（最后一个单词不加）
                if (currentIndex < files.length - 1) {
                    writer.write(betweenWordsSilence);
                }

                currentIndex++;
                processNext();
            } catch (error) {
                reject(error);
            }
        };

        processNext();
    });
}

// 主执行函数
async function main() {
    try {
        await fs.promises.mkdir(config.outputDir, { recursive: true });

        const words = await loadWords();
        console.log(`加载单词: ${words.length}个`);

        const app = await client("https://ea668b696d7dca25ce.gradio.live/");
        await app.predict("/change_sovits_weights", [
            config.sovitsWeight,
            config.refLang,
            "English",
        ]);
        await app.predict("/change_gpt_weights", [config.gptWeight]);

        for (const wordData of words) {
            await generateWordAudio(wordData);
        }

        console.log("✅ 所有单词音频生成完成");

        // 拼接示例
        const filesToConcat = [];
        for (const wordData of words) {
            const word = wordData.word;
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
