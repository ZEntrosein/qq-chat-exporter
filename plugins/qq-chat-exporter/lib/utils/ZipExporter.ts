/**
 * ZIP导出器
 * 用于将HTML文件和资源文件打包成ZIP格式
 */

import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

/**
 * ZIP导出器类
 */
export class ZipExporter {
    /**
     * 创建ZIP文件
     * @param htmlPath HTML文件路径
     * @param outputZipPath 输出ZIP文件路径
     * @param resourcePaths 资源文件相对路径列表（相对于HTML所在目录）
     * @returns ZIP文件路径
     */
    static async createZip(htmlPath: string, outputZipPath: string, resourcePaths: string[] = []): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                // 验证HTML文件存在
                if (!fs.existsSync(htmlPath)) {
                    throw new Error(`HTML文件不存在: ${htmlPath}`);
                }

                // 获取HTML文件所在目录和文件名
                const htmlDir = path.dirname(htmlPath);
                const htmlFileName = path.basename(htmlPath);

                // 创建写入流
                const output = fs.createWriteStream(outputZipPath);
                const archive = archiver('zip', {
                    zlib: { level: 9 } // 最高压缩级别
                });

                // 监听完成事件
                output.on('close', () => {
                    resolve(outputZipPath);
                });

                // 监听错误事件
                archive.on('error', (err) => {
                    console.error('[ZipExporter] 创建ZIP文件时出错:', err);
                    reject(err);
                });

                output.on('error', (err) => {
                    console.error('[ZipExporter] 写入ZIP文件时出错:', err);
                    reject(err);
                });

                // 监听警告事件
                archive.on('warning', (err) => {
                    if (err.code === 'ENOENT') {
                        // 静默处理 ENOENT 警告
                    } else {
                        reject(err);
                    }
                });

                // 将归档流输出到文件
                archive.pipe(output);

                // 添加HTML文件到ZIP根目录
                archive.file(htmlPath, { name: htmlFileName });

                // 添加指定的资源文件
                if (resourcePaths.length > 0) {
                    // 同一个媒体可能被多条消息引用，导出器会多次返回相同路径。
                    // ZIP 中同名 entry 会让解压软件提示“文件已存在”，因此在最终写入边界统一去重。
                    const seenEntries = new Set<string>();
                    for (const rawResourcePath of resourcePaths) {
                        const resourcePath = rawResourcePath
                            .replace(/\\/g, '/')
                            .replace(/^\.\/+/, '');
                        if (!resourcePath || path.posix.isAbsolute(resourcePath) || resourcePath.split('/').includes('..')) {
                            continue;
                        }

                        // Windows 解压目录不区分大小写，大小写不同也视为同一个目标文件。
                        const entryKey = process.platform === 'win32'
                            ? resourcePath.toLowerCase()
                            : resourcePath;
                        if (seenEntries.has(entryKey)) continue;
                        seenEntries.add(entryKey);

                        const absolutePath = path.resolve(htmlDir, ...resourcePath.split('/'));
                        const relativeToHtml = path.relative(htmlDir, absolutePath);
                        if (relativeToHtml.startsWith('..') || path.isAbsolute(relativeToHtml)) continue;

                        if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
                            // 使用相对路径作为ZIP内的路径，保持目录结构
                            archive.file(absolutePath, { name: resourcePath });
                        }
                    }
                }

                // 完成归档
                archive.finalize();
            } catch (error) {
                console.error('[ZipExporter] ZIP创建失败:', error);
                reject(error);
            }
        });
    }

    /**
     * 删除原始HTML文件和resources目录
     * @param htmlPath HTML文件路径
     * @returns 是否删除成功
     */
    static async deleteOriginalFiles(htmlPath: string): Promise<boolean> {
        try {
            const htmlDir = path.dirname(htmlPath);
            const resourcesDir = path.join(htmlDir, 'resources');

            // 删除HTML文件
            if (fs.existsSync(htmlPath)) {
                fs.unlinkSync(htmlPath);
            }

            // 删除resources目录
            if (fs.existsSync(resourcesDir)) {
                fs.rmSync(resourcesDir, { recursive: true, force: true });
            }

            return true;
        } catch (error) {
            console.error('[ZipExporter] 删除原始文件失败:', error);
            return false;
        }
    }
}


