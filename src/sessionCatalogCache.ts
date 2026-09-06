/**
 * Per-session catalog cache: value map, in-flight request dedup, and
 * invalidation generations with one queued re-pull. The model, skill and
 * command catalogs in ChatViewProvider hand-copied this concurrency shape
 * three times; this is the one implementation.
 */
export class SessionCatalogCache<T> {
    private readonly values = new Map<string, T>();
    private readonly requests = new Map<string, Promise<void>>();
    private readonly generations = new Map<string, number>();
    private readonly refreshPending = new Set<string>();

    public get(sessionId: string): T | undefined {
        return this.values.get(sessionId);
    }

    public has(sessionId: string): boolean {
        return this.values.has(sessionId);
    }

    /** Direct write from flows that own the value, bypassing pull bookkeeping. */
    public set(sessionId: string, value: T): void {
        this.values.set(sessionId, value);
    }

    public delete(sessionId: string): void {
        this.values.delete(sessionId);
    }

    /** Drops cached values only; in-flight pulls keep applying their result. */
    public clear(): void {
        this.values.clear();
    }

    /**
     * Drops cached values and marks in-flight pulls stale so their results
     * are discarded; each marked pull re-pulls once after it settles.
     */
    public invalidate(): void {
        this.values.clear();
        for (const sessionId of this.requests.keys()) {
            this.refreshPending.add(sessionId);
            this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
        }
    }

    /**
     * Runs `pull` once per session: a no-op while `gate` is false, the value
     * is cached, or a request is already in flight. `apply` receives the
     * pulled value only while no invalidation bumped the generation meanwhile;
     * `absent` runs when the pull resolves without a value (an older Runtime
     * serving no registry, for one). Awaiting the returned promise never
     * rejects — failures go to `fail`.
     */
    public pull(
        sessionId: string,
        options: {
            gate?: () => boolean;
            pull: () => Promise<T | undefined>;
            apply: (value: T) => void;
            absent?: () => void;
            fail: (error: unknown) => void;
        },
    ): Promise<void> {
        const pending = this.requests.get(sessionId);
        if (pending) return pending;
        if (options.gate && !options.gate()) return Promise.resolve();
        if (this.values.has(sessionId)) return Promise.resolve();
        const generation = this.generations.get(sessionId) ?? 0;
        const request = options.pull()
            .then((value) => {
                if (this.generations.get(sessionId) !== generation) return;
                if (value === undefined) {
                    options.absent?.();
                    return;
                }
                options.apply(value);
            })
            .catch((error) => options.fail(error))
            .finally(() => {
                this.requests.delete(sessionId);
                if (this.refreshPending.delete(sessionId)) {
                    void this.pull(sessionId, options);
                }
            });
        this.requests.set(sessionId, request);
        return request;
    }
}
