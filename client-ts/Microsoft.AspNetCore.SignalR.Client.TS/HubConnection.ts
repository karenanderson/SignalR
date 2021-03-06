import { ConnectionClosed } from "./Common"
import { IConnection } from "./IConnection"
import { TransportType } from "./Transports"
import { Subject, Observable } from "./Observable"
export { TransportType } from "./Transports"
export { HttpConnection } from "./HttpConnection"
import { IHubProtocol, MessageType, HubMessage, CompletionMessage, ResultMessage, InvocationMessage } from "./IHubProtocol";
import { JsonHubProtocol } from "./JsonHubProtocol";

export class HubConnection {
    private connection: IConnection;
    private callbacks: Map<string, (invocationUpdate: CompletionMessage | ResultMessage) => void>;
    private methods: Map<string, (...args: any[]) => void>;
    private id: number;
    private connectionClosedCallback: ConnectionClosed;
    private protocol: IHubProtocol;

    constructor(connection: IConnection) {
        this.connection = connection;
        this.connection.onDataReceived = data => {
            this.onDataReceived(data);
        };
        this.connection.onClosed = (error: Error) => {
            this.onConnectionClosed(error);
        }

        this.callbacks = new Map<string, (invocationEvent: CompletionMessage | ResultMessage) => void>();
        this.methods = new Map<string, (...args: any[]) => void>();
        this.id = 0;
        this.protocol = new JsonHubProtocol();
    }

    private onDataReceived(data: any) {
        // Parse the messages
        let messages = this.protocol.parseMessages(data);

        for (var i = 0; i < messages.length; ++i) {
            var message = messages[i];

            switch (message.type) {
                case MessageType.Invocation:
                    this.InvokeClientMethod(<InvocationMessage>message);
                    break;
                case MessageType.Result:
                case MessageType.Completion:
                    let callback = this.callbacks.get(message.invocationId);
                    if (callback != null) {
                        callback(message);

                        if (message.type == MessageType.Completion) {
                            this.callbacks.delete(message.invocationId);
                        }
                    }
                    break;
                default:
                    console.log("Invalid message type: " + data);
                    break;
            }
        }
    }

    private InvokeClientMethod(invocationMessage: InvocationMessage) {
        let method = this.methods.get(invocationMessage.target);
        if (method) {
            method.apply(this, invocationMessage.arguments);
            if (!invocationMessage.nonblocking) {
                // TODO: send result back to the server?
            }
        }
        else {
            console.log(`No client method with the name '${invocationMessage.target}' found.`);
        }
    }

    private onConnectionClosed(error: Error) {
        let errorCompletionMessage = <CompletionMessage>{
            type: MessageType.Completion,
            invocationId: "-1",
            error: error ? error.message : "Invocation cancelled due to connection being closed.",
        };

        this.callbacks.forEach(callback => {
            callback(errorCompletionMessage);
        });
        this.callbacks.clear();

        if (this.connectionClosedCallback) {
            this.connectionClosedCallback(error);
        }
    }

    start(): Promise<void> {
        return this.connection.start();
    }

    stop(): void {
        return this.connection.stop();
    }

    stream<T>(methodName: string, ...args: any[]): Observable<T> {
        let invocationDescriptor = this.createInvocation(methodName, args);

        let subject = new Subject<T>();

        this.callbacks.set(invocationDescriptor.invocationId, (invocationEvent: CompletionMessage | ResultMessage) => {
            if (invocationEvent.type === MessageType.Completion) {
                let completionMessage = <CompletionMessage>invocationEvent;
                if (completionMessage.error) {
                    subject.error(new Error(completionMessage.error));
                }
                else if (completionMessage.result) {
                    subject.error(new Error("Server provided a result in a completion response to a streamed invocation."));
                }
                else {
                    // TODO: Log a warning if there's a payload?
                    subject.complete();
                }
            }
            else {
                subject.next(<T>(<ResultMessage>invocationEvent).item);
            }
        });

        let message = this.protocol.writeMessage(invocationDescriptor);

        this.connection.send(message)
            .catch(e => {
                subject.error(e);
                this.callbacks.delete(invocationDescriptor.invocationId);
            });

        return subject;
    }

    invoke(methodName: string, ...args: any[]): Promise<any> {
        let invocationDescriptor = this.createInvocation(methodName, args);

        let p = new Promise<any>((resolve, reject) => {
            this.callbacks.set(invocationDescriptor.invocationId, (invocationEvent: CompletionMessage | ResultMessage) => {
                if (invocationEvent.type === MessageType.Completion) {
                    let completionMessage = <CompletionMessage>invocationEvent;
                    if (completionMessage.error) {
                        reject(new Error(completionMessage.error));
                    }
                    else {
                        resolve(completionMessage.result);
                    }
                }
                else {
                    reject(new Error("Streaming methods must be invoked using HubConnection.stream"))
                }
            });

            let message = this.protocol.writeMessage(invocationDescriptor);

            this.connection.send(message)
                .catch(e => {
                    reject(e);
                    this.callbacks.delete(invocationDescriptor.invocationId);
                });
        });

        return p;
    }

    on(methodName: string, method: (...args: any[]) => void) {
        this.methods.set(methodName, method);
    }

    set onClosed(callback: ConnectionClosed) {
        this.connectionClosedCallback = callback;
    }

    private createInvocation(methodName: string, args: any[]): InvocationMessage {
        let id = this.id;
        this.id++;

        return <InvocationMessage>{
            type: MessageType.Invocation,
            invocationId: id.toString(),
            target: methodName,
            arguments: args,
            nonblocking: false
        };
    }
}
