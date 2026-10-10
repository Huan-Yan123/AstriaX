import { ref } from 'vue';
import type { DialogButton } from '../AppDialog.vue';
export function useLauncherDialogs() {
    interface DlgState {
        title: string;
        body?: string;
        buttons: DialogButton[];
        requireText?: string;
        inputPlaceholder?: string;
        error?: string;
        choiceList?: boolean;
        onPick?: (v: unknown) => void;
    }
    const dlg = ref<DlgState | null>(null);
    const OFFICIAL_GROUP = '1077554004';
    const FEEDBACK_LINE = `\n\n—— 搞不定的话去群里问：${OFFICIAL_GROUP}（问题反馈群）`;
    function note(title: string, body?: string, opts?: {
        feedback?: boolean;
    }): void {
        dlg.value = {
            title,
            body: opts?.feedback ? `${body ?? ''}${FEEDBACK_LINE}` : body,
            buttons: [{ text: '知道了', kind: 'main', value: true }]
        };
    }
    function ask(title: string, body: string, onYes: () => void, danger = false): void {
        dlg.value = {
            title,
            body,
            buttons: [
                { text: '取消', kind: 'ghost', value: false },
                { text: '确定', kind: danger ? 'danger' : 'main', value: true }
            ],
            onPick: (v) => {
                if (v)
                    onYes();
            }
        };
    }
    function onDlgPick(v: unknown): void {
        if (v && typeof v === 'object' && '__invalid' in v) {
            dlg.value = dlg.value ? { ...dlg.value, error: '名字不一致——请输入实例完整名称' } : null;
            return;
        }
        const cb = dlg.value?.onPick;
        dlg.value = null;
        cb?.(v);
    }
    function choose(title: string, body: string, yes: string, no: string, opts?: {
        feedback?: boolean;
    }): Promise<boolean> {
        return new Promise((resolve) => {
            dlg.value = {
                title,
                body: opts?.feedback ? `${body}${FEEDBACK_LINE}` : body,
                buttons: [
                    { text: no, kind: 'ghost', value: false },
                    { text: yes, kind: 'main', value: true }
                ],
                onPick: (v) => resolve(v === true)
            };
        });
    }
    function chooseOne(title: string, body: string, options: Array<{
        text: string;
        value: string;
        current?: boolean;
    }>): Promise<string | null> {
        return new Promise((resolve) => {
            dlg.value = {
                title,
                body,
                choiceList: true,
                buttons: [
                    { text: '取消', kind: 'ghost', value: null },
                    ...options.map((o) => ({
                        text: o.text,
                        kind: 'main' as const,
                        value: o.value,
                        current: o.current
                    }))
                ],
                onPick: (v) => resolve(typeof v === 'string' ? v : null)
            };
        });
    }
    return { dlg, note, ask, onDlgPick, choose, chooseOne };
}
