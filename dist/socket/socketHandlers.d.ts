import { Server as SocketIOServer } from 'socket.io';
export declare const setupSocketHandlers: (io: SocketIOServer) => void;
export declare const getActiveUserConnections: (userId: string) => string[];
export declare const getUserPresence: (userId: string) => boolean;
export declare const broadcastToUser: (io: SocketIOServer, userId: string, event: string, data: any) => void;
export declare const broadcastToProject: (io: SocketIOServer, projectId: string, event: string, data: any) => void;
declare const _default: {
    setupSocketHandlers: (io: SocketIOServer) => void;
    getActiveUserConnections: (userId: string) => string[];
    getUserPresence: (userId: string) => boolean;
    broadcastToUser: (io: SocketIOServer, userId: string, event: string, data: any) => void;
    broadcastToProject: (io: SocketIOServer, projectId: string, event: string, data: any) => void;
};
export default _default;
//# sourceMappingURL=socketHandlers.d.ts.map