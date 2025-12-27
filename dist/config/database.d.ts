declare const connectDB: () => Promise<void>;
export declare const checkDatabaseHealth: () => Promise<boolean>;
export declare const getDatabaseStats: () => Promise<{
    database: string;
    collections: any;
    documents: any;
    storageSize: any;
    indexSize: any;
    dataSize: any;
}>;
export default connectDB;
//# sourceMappingURL=database.d.ts.map