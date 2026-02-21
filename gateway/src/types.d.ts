import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      deviceId: string;
      deviceName?: string;
    };
  }
}
