import type { sandbox as zh } from "../zh/sandbox.js";
export const sandbox: typeof zh = {
    codexInstallFailed: (version: string, output: string) => `No se pudo instalar la CLI de Codex del entorno aislado (se requiere @openai/codex@${version}): ${output}`,
    codexVerifyFailed: (expected: string, actual: string) => `La CLI de Codex del entorno aislado no superó la comprobación tras instalarse: se esperaba ${expected} y se encontró ${actual}`,
    claudeInstallFailed: (version: string, output: string) => `No se pudo instalar la CLI de Claude Code del entorno aislado (se requiere @anthropic-ai/claude-code@${version}): ${output}`,
    claudeVerifyFailed: (expected: string, actual: string) => `La CLI de Claude Code del entorno aislado no superó la comprobación tras instalarse: se esperaba ${expected} y se encontró ${actual}`,
    claudeConfigFailed: (output: string) => `No se pudo preparar el directorio de configuración de Claude Code: ${output}`,
    startFailed: "El entorno aislado no pudo iniciarse. Inténtalo de nuevo más tarde.",
    node: {
        incompatible: (node: string, protocol: number | string, range: string) => `El nodo del entorno aislado ${node} usa el protocolo ${protocol}, fuera del rango ${range} que admite este plano de control`,
        unreachable: (node: string, error: string) => `No se puede conectar con el nodo del entorno aislado ${node}: ${error}`,
        httpStatus: (node: string, status: number) => `El nodo del entorno aislado ${node} respondió HTTP ${status}`,
        unauthorized: "El token del nodo no es válido",
        containerForeign: (name: string) => `El nombre de contenedor ${name} lo ocupa un contenedor que este sistema no creó (le falta la etiqueta personal-agent.managed=1). Revísalo a mano y cambia el nombre de ese contenedor o elimínalo.`,
        imageMismatch: (name: string, image: string, expected: string) => `El contenedor ${name} usa la imagen ${image}, distinta de la imagen fijada ${expected}, así que no se tomó el control automáticamente.`,
        volumeMissing: (name: string, volume: string, destination: string) => `Al contenedor ${name} le falta el volumen persistente ${volume} -> ${destination}, así que no se tomó el control para evitar perder datos.`,
        sandboxMissing: (name: string) => `El entorno aislado ${name} no existe`,
        sandboxUnmanaged: (name: string) => `El contenedor ${name} no es un entorno aislado gestionado por este sistema`,
        noWebPort: (name: string) => `El entorno aislado ${name} no publica ningún puerto web`,
    },
};
