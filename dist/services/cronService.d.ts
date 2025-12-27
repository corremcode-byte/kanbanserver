declare class CronService {
    private tasks;
    start(): void;
    stop(): void;
    private startTaskDeadlineReminders;
    private checkTaskDeadlines;
    manualCheckDeadlines(): Promise<void>;
}
export declare const cronService: CronService;
export {};
//# sourceMappingURL=cronService.d.ts.map