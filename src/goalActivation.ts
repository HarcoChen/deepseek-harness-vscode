import { isRecord } from "./guards";
import type { DshGoalActivation, DshGoalActivationState, DshGoalRef } from "./types";

/** Orders authoritative reads against projection changes, live events, and reconnects. */
export class GoalActivationController {
    private sessionId: string | undefined;
    private ref: DshGoalRef | undefined;
    private running = false;
    private value: DshGoalActivationState | undefined;
    private epoch = 0;
    private disposed = false;

    public constructor(
        private readonly read: (sessionId: string) => Promise<DshGoalActivationState | undefined>,
        private readonly onChange: () => void,
    ) {}

    public observe(sessionId: string | undefined, ref: DshGoalRef | undefined, running: boolean): void {
        const sessionChanged = this.sessionId !== sessionId;
        const changed = sessionChanged || this.ref?.id !== ref?.id || this.ref?.revision !== ref?.revision;
        const runningChanged = this.running !== running;
        this.sessionId = sessionId;
        this.ref = ref && { ...ref };
        this.running = running;
        if (sessionChanged || !ref) this.value = undefined;
        if (changed || runningChanged) this.refresh();
    }

    public activationFor(sessionId: string, ref: DshGoalRef): DshGoalActivation | undefined {
        return this.sessionId === sessionId && this.value?.id === ref.id && this.value.revision === ref.revision
            ? this.value.activation : undefined;
    }

    public accept(payload: unknown): void {
        if (!isRecord(payload) || payload.sessionId !== this.sessionId) return;
        const goal = payload.goal;
        if (goal !== undefined && (!isRecord(goal) || typeof goal.id !== "string" ||
            !Number.isSafeInteger(goal.revision) || Number(goal.revision) < 1 ||
            (goal.activation !== "armed" && goal.activation !== "disarmed"))) return;
        ++this.epoch;
        this.value = goal === undefined ? undefined : {
            id: goal.id as string,
            revision: goal.revision as number,
            activation: goal.activation as DshGoalActivation,
        };
        this.onChange();
    }

    public reset(): void {
        this.value = undefined;
        this.refresh();
        this.onChange();
    }

    public dispose(): void {
        this.disposed = true;
        ++this.epoch;
    }

    private refresh(): void {
        const epoch = ++this.epoch;
        const { sessionId, ref } = this;
        if (!sessionId || !ref || this.disposed) return;
        void this.read(sessionId).then((value) => {
            if (this.disposed || epoch !== this.epoch) return;
            if (value !== undefined && (value.id !== ref.id || value.revision !== ref.revision)) return;
            // Absence clears the cached activation, including its goal reference.
            // Keep the observed projection ref so publishing cannot restart this read.
            this.value = value;
            this.onChange();
        }).catch(() => {
            // Cold sessions may have no live Agent. A later running edge retries.
        });
    }
}
