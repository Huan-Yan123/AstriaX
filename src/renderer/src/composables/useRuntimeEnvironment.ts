import { ref, type Ref } from 'vue';
interface Options {
    overview(): Promise<{
        system?: {
            osVersion?: string;
            cpuModel?: string;
            gpuModel?: string;
            totalMemMB?: number;
            freeMemMB?: number;
        };
    } | undefined> | undefined;
    py: Ref<{
        ready: boolean;
        version: string;
    } | null>;
    qq: Ref<{
        ok?: boolean;
        installed?: boolean;
        version?: string;
    } | null>;
    checkQQ(): Promise<void>;
}
export function useRuntimeEnvironment(options: Options) {
    interface EnvironmentInfo {
        os: string;
        cpu: string;
        gpu: string;
        memory: string;
        memoryUsed: string;
        memoryFree: string;
        python: string;
        qq: string;
    }
    const environment = ref<EnvironmentInfo | null>(null);
    const environmentLoading = ref(false);
    function mb(value: number): string {
        if (!Number.isFinite(value) || value <= 0)
            return '—';
        return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
    }
    function cleanCpu(raw: string): string {
        return raw.replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s{2,}/g, ' ').trim() || '未检测到';
    }
    function cleanGpu(raw: string): string {
        const value = raw.replace(/^ANGLE\s*\((?:有线|[^,]+,\s*)?/i, '').replace(/\)$/, '');
        return value.split(/\s+Direct3D|\s+OpenGL|\s+Metal|\s+Vulkan|\s+vs_|\s+ps_/i)[0].replace(/\s+\([^)]*\)$/, '').trim() || '未检测到';
    }
    function formatWindows(raw: string): string {
        const build = Number(raw.match(/\d+$/)?.[0] ?? 0);
        if (build >= 26200)
            return `Windows 11 · 25H2（Build ${build}）`;
        if (build >= 26100)
            return `Windows 11 · 24H2（Build ${build}）`;
        if (build >= 22000)
            return `Windows 11（Build ${build}）`;
        if (build >= 10240)
            return `Windows 10（Build ${build}）`;
        return raw || 'Windows';
    }
    function detectGpu(): string {
        try {
            const canvas = document.createElement('canvas');
            const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
            if (!gl)
                return '未检测到';
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            return cleanGpu(ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)));
        }
        catch {
            return '未检测到';
        }
    }
    async function refreshEnvironment(): Promise<void> {
        await Promise.all([loadEnvironment(), options.checkQQ()]);
        await loadEnvironment();
    }
    async function loadEnvironment(): Promise<void> {
        if (environmentLoading.value)
            return;
        environmentLoading.value = true;
        try {
            const overview = await options.overview();
            const sys = overview?.system;
            const total = sys?.totalMemMB ?? 0;
            const free = sys?.freeMemMB ?? 0;
            environment.value = {
                os: formatWindows(sys?.osVersion ?? 'Windows'),
                cpu: cleanCpu(sys?.cpuModel ?? '未检测到'),
                gpu: cleanGpu(sys?.gpuModel || detectGpu()),
                memory: mb(total),
                memoryUsed: mb(Math.max(0, total - free)),
                memoryFree: mb(free),
                python: options.py.value?.ready ? `Python ${options.py.value.version}` : '未安装',
                qq: options.qq.value?.ok
                    ? `QQ ${options.qq.value.version ?? ''}`.trim()
                    : options.qq.value?.installed
                        ? (options.qq.value.version ? 'QQ 版本不符合' : 'QQ 版本读取失败')
                        : '未安装 QQ'
            };
        }
        finally {
            environmentLoading.value = false;
        }
    }
    return { environment, environmentLoading, refreshEnvironment, loadEnvironment };
}
