import { ref, computed, onUnmounted } from 'vue';
import type { Progress } from '../types/runtime-center';
export function useDownloadProgress(options: {
    cancel(payload: {
        type: 'a' | 'n' | 'python';
        tag: string;
    }): Promise<{
        ok: boolean;
    } | undefined> | undefined;
    reload(): Promise<void>;
}) {
    const progressMap = ref<Map<string, Progress>>(new Map());
    const progressList = computed(() => [...progressMap.value.values()]);
    const STALL_MS = 5000;
    const lastEventAt = new Map<string, number>();
    const stallTick = ref(0);
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    function markEvent(key: string): void {
        lastEventAt.set(key, Date.now());
        if (!stallTimer && progressMap.value.size > 0) {
            stallTimer = setInterval(() => {
                stallTick.value++;
                if (progressMap.value.size === 0) {
                    clearInterval(stallTimer);
                    stallTimer = undefined;
                }
            }, 1000);
        }
    }
    function isStalled(p: Progress): boolean {
        void stallTick.value;
        if (p.phase === 'done' || p.phase === 'error')
            return false;
        const at = lastEventAt.get(trackKey(p));
        if (!at)
            return false;
        return Date.now() - at > STALL_MS;
    }
    function elapsedSec(p: Progress): number {
        void stallTick.value;
        const fromMain = (p as {
            startedAt?: number;
        }).startedAt;
        const at = fromMain ?? startedAt.get(trackKey(p));
        if (!at)
            return 0;
        return Math.max(0, Math.round((Date.now() - at) / 1000));
    }
    const startedAt = new Map<string, number>();
    const cancelling = ref<Set<string>>(new Set());
    async function cancelTask(p: Progress): Promise<void> {
        const key = trackKey(p);
        if (cancelling.value.has(key))
            return;
        cancelling.value = new Set([...cancelling.value, key]);
        try {
            const r = await options.cancel({ type: p.type, tag: p.tag });
            if (!r?.ok) {
                const next = new Set(cancelling.value);
                next.delete(key);
                cancelling.value = next;
                return;
            }
            const next = new Map(progressMap.value);
            const current = next.get(key);
            // The terminal event may arrive before this acknowledgement.
            if (!current || current.phase === 'done' || current.phase === 'error') return;
            next.set(key, {
                ...current,
                label: '正在取消，等待后台清理…'
            });
            progressMap.value = next;
        }
        catch {
            const next = new Set(cancelling.value);
            next.delete(key);
            cancelling.value = next;
        }
    }
    function trackKey(p: Progress): string {
        return `${p.type}|${p.tag}`;
    }
    function setProgress(p: Progress): void {
        const next = new Map(progressMap.value);
        const terminal = p.phase === 'done' || p.phase === 'error';
        next.set(trackKey(p), cancelling.value.has(trackKey(p)) && !terminal
            ? { ...p, label: '正在取消，等待后台清理…' } : p);
        progressMap.value = next;
        if (!startedAt.has(trackKey(p)))
            startedAt.set(trackKey(p), Date.now());
        markEvent(trackKey(p));
        if (p.phase === 'done' || p.phase === 'error') {
            if (cancelling.value.has(trackKey(p))) {
                const nx = new Set(cancelling.value);
                nx.delete(trackKey(p));
                cancelling.value = nx;
            }
        }
        if (p.phase === 'done') {
            void options.reload();
            scheduleClear(trackKey(p), 2500);
        }
        else if (p.phase === 'error') {
            scheduleClear(trackKey(p), 6000);
        }
    }
    const pendingClear = new Set<ReturnType<typeof setTimeout>>();
    function scheduleClear(key: string, ms: number): void {
        const id = setTimeout(() => {
            pendingClear.delete(id);
            clearProgress(key);
        }, ms);
        pendingClear.add(id);
    }
    function cancelPendingClears(): void {
        for (const id of pendingClear)
            clearTimeout(id);
        pendingClear.clear();
    }
    function clearProgress(key: string): void {
        const cur = progressMap.value.get(key);
        if (cur && cur.phase !== 'done' && cur.phase !== 'error')
            return;
        const next = new Map(progressMap.value);
        next.delete(key);
        progressMap.value = next;
        startedAt.delete(key);
        lastEventAt.delete(key);
    }
    onUnmounted(() => {
        cancelPendingClears();
        if (stallTimer)
            clearInterval(stallTimer);
    });
    return { progressList, cancelling, isStalled, elapsedSec, trackKey, setProgress, cancelTask };
}
