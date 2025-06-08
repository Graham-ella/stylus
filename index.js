import { client } from "@gradio/client";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { Blob } from "buffer";
import csv from "csv-parser";
import wav from "wav";
import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);
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
        await generateTTS(exampleAudio, word, "English", "No slice", enPath);

        // 中文部分（单独生成）
        const zhPath = path.join(versionDir, `${word}_zh.wav`);
        await generateTTS(exampleAudio, meaning, "Chinese", "No slice", zhPath);

        console.log(`✅ 完成: ${word} 版本 ${i}`);
    }

    return wordDir;
}

// 创建静音片段
async function createSilence(duration, outputPath) {
    // 使用ffmpeg生成静音片段
    const command = `ffmpeg -f lavfi -i anullsrc=r=32000:cl=mono -t ${duration} -acodec pcm_s16le ${outputPath}`;
    await execAsync(command);
    return outputPath;
}

// 拼接音频文件（带间隔）
async function concatWithPauses(files, pauses, outputPath) {
    // 临时文件列表
    const tempFiles = [];

    // 生成所有需要的静音片段
    const silenceBetweenEn = await createSilence(
        pauses.betweenEnglish,
        path.join(config.outputDir, "silence_between_en.wav")
    );

    const silenceBetweenEnZh = await createSilence(
        pauses.betweenEnZh,
        path.join(config.outputDir, "silence_between_en_zh.wav")
    );

    const silenceBetweenWords = await createSilence(
        pauses.betweenWords,
        path.join(config.outputDir, "silence_between_words.wav")
    );

    // 创建拼接列表文件
    const concatList = [];

    for (let i = 0; i < files.length; i++) {
        // 当前单词的英文文件
        concatList.push(`file '${files[i].en}'`);

        // 英文两遍之间的间隔
        concatList.push(`file '${silenceBetweenEn}'`);

        // 英文第二遍（同一文件重复使用）
        concatList.push(`file '${files[i].en}'`);

        // 英文和中文之间的间隔
        concatList.push(`file '${silenceBetweenEnZh}'`);

        // 中文部分
        concatList.push(`file '${files[i].zh}'`);

        // 单词之间的间隔（最后一个单词不加）
        if (i < files.length - 1) {
            concatList.push(`file '${silenceBetweenWords}'`);
        }
    }

    const listFilePath = path.join(config.outputDir, "concat_list.txt");
    await fs.promises.writeFile(listFilePath, concatList.join("\n"));

    // 使用ffmpeg拼接
    const command = `ffmpeg -f concat -safe 0 -i "${listFilePath}" -c copy "${outputPath}"`;
    await execAsync(command);

    // 清理临时文件
    await fs.promises.unlink(listFilePath);

    return outputPath;
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
            "English", // 设置为英文，因为我们会单独调用中文
        ]);
        await app.predict("/change_gpt_weights", [config.gptWeight]);

        // 生成所有单词音频
        for (const wordData of words) {
            await generateWordAudio(wordData);
        }

        console.log("✅ 所有单词音频生成完成");

        // 拼接示例（使用第一个版本）

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
