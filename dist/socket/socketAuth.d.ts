import { Socket } from 'socket.io';
export interface AuthenticatedSocket extends Socket {
    user?: any;
}
export declare const socketAuth: (socket: AuthenticatedSocket, next: Function) => Promise<any>;
export declare const getSocketUserId: (socket: AuthenticatedSocket) => string | null;
export declare const canJoinRoom: (socket: AuthenticatedSocket, roomType: string, roomId: string) => Promise<boolean>;
declare const _default: {
    socketAuth: (socket: AuthenticatedSocket, next: Function) => Promise<any>;
    getSocketUserId: (socket: AuthenticatedSocket) => string | null;
    canJoinRoom: (socket: AuthenticatedSocket, roomType: string, roomId: string) => Promise<boolean>;
};
export default _default;
//# sourceMappingURL=socketAuth.d.ts.map