'use strict';

/**
 * Screenshot capture through the main-process `take-screenshot` IPC (which hides the
 * companion's own window from the capture) plus pure coordinate-mapping helpers.
 * Everything that touches Electron is injectable so the math is unit-testable.
 */

function intersectRects(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
}

function monitorToRect(monitor) {
    return {
        left: monitor.left,
        top: monitor.top,
        right: monitor.left + monitor.width,
        bottom: monitor.top + monitor.height
    };
}

/** Which physical monitor (from the worker's mss list, index >= 1) contains a point. */
function monitorForPoint(monitors, point) {
    const real = (monitors || []).filter(m => m && Number.isFinite(m.width) && m.index !== 0);
    if (real.length === 0) return null;
    if (real.length === 1 || !point) return real[0];
    return real.find(m => point.x >= m.left && point.x < m.left + m.width && point.y >= m.top && point.y < m.top + m.height)
        || real[0];
}

/**
 * Builds the screenshot-pixel -> physical-pixel mapping.
 * @param {object} monitor   physical monitor {left, top, width, height}
 * @param {object} rendered  size of the captured (downscaled) image {width, height}
 * @param {object|null} windowRect physical window rect to crop to, or null for the whole display
 */
function buildMapping(monitor, rendered, windowRect) {
    const scale = rendered.width / monitor.width;
    const monitorRect = monitorToRect(monitor);
    let region = monitorRect;
    let crop = null;
    if (windowRect) {
        const inter = intersectRects(windowRect, monitorRect);
        if (!inter) throw new Error('目标窗口不在当前显示器上，无法截取');
        region = inter;
        const x = Math.max(0, Math.round((inter.left - monitor.left) * scale));
        const y = Math.max(0, Math.round((inter.top - monitor.top) * scale));
        const width = Math.min(rendered.width - x, Math.max(1, Math.round((inter.right - inter.left) * scale)));
        const height = Math.min(rendered.height - y, Math.max(1, Math.round((inter.bottom - inter.top) * scale)));
        crop = { x, y, width, height };
    }
    return {
        mode: windowRect ? 'window' : 'screen',
        scale,
        origin: { x: region.left, y: region.top },
        region,
        monitor: monitorRect,
        crop,
        renderedWidth: crop ? crop.width : rendered.width,
        renderedHeight: crop ? crop.height : rendered.height
    };
}

/** Screenshot pixel -> physical screen pixel, clamped to the observed region. */
function toScreen(mapping, x, y) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('坐标必须是数字');
    if (px < -2 || py < -2 || px > mapping.renderedWidth + 2 || py > mapping.renderedHeight + 2) {
        throw new Error(`坐标 (${x},${y}) 超出了截图范围 ${mapping.renderedWidth}×${mapping.renderedHeight}`);
    }
    const sx = Math.round(mapping.origin.x + px / mapping.scale);
    const sy = Math.round(mapping.origin.y + py / mapping.scale);
    const { region } = mapping;
    return {
        x: Math.min(region.right - 1, Math.max(region.left, sx)),
        y: Math.min(region.bottom - 1, Math.max(region.top, sy))
    };
}

class ScreenshotService {
    constructor(options = {}) {
        this.ipc = options.ipcRenderer || null;
        this.nativeImage = options.nativeImage || null;
        this.log = options.log || (() => {});
        if (!this.ipc || !this.nativeImage) {
            try {
                const electron = require('electron');
                this.ipc = this.ipc || electron.ipcRenderer;
                this.nativeImage = this.nativeImage || electron.nativeImage;
            } catch (_) {
                // unit tests inject fakes
            }
        }
    }

    available() {
        return !!(this.ipc && this.nativeImage);
    }

    /** Full capture of the display under the cursor, already downscaled by the main process. */
    async captureDisplay({ maxLongEdge = 1600, jpegQuality = 80, timeoutMs = 15000 } = {}) {
        if (!this.available()) throw new Error('截图通道不可用（不在 Electron 渲染进程中）');
        const base64 = await this.ipc.invoke('take-screenshot', {
            maxLongEdge,
            jpegQuality,
            requestTimeoutMs: timeoutMs
        });
        if (!base64) throw new Error('主进程截图返回为空');
        const image = this.nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
        const size = image.getSize();
        return { base64, image, width: size.width, height: size.height };
    }

    /** Crops a captured image to the mapping's crop rect and re-encodes as JPEG. */
    cropImage(capture, mapping, jpegQuality = 80) {
        if (!mapping.crop) return { base64: capture.base64, width: capture.width, height: capture.height };
        const cropped = capture.image.crop(mapping.crop);
        const size = cropped.getSize();
        return {
            base64: cropped.toJPEG(Math.min(95, Math.max(45, jpegQuality))).toString('base64'),
            width: size.width,
            height: size.height
        };
    }
}

module.exports = { ScreenshotService, buildMapping, toScreen, monitorForPoint, intersectRects, monitorToRect };
