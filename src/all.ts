// API + outbox relay + workers in one process, for single-instance hosts (Render free tier).
// Production runs them as separate services (docker-compose, ECS).
import { main as api } from "./api/server.js";
import { main as worker } from "./worker/index.js";

await api();
worker();
