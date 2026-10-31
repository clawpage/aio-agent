import type { knowledge as zh } from "../zh/knowledge.js";
export const knowledge: typeof zh = {
  notFound: "No existe esa biblioteca compartida o no eres miembro",
  adminOnly: "Solo el administrador puede hacer eso",
  badName: (max: number) => `El nombre no puede estar vacío y tiene como máximo ${max} caracteres`,
  rulesTooLong: (max: number) => `Las reglas tienen como máximo ${max} caracteres`,
  sensitive: "Parece contener una contraseña, un código, un número de documento o de tarjeta, que nunca se guardan en una base de conocimiento",
  inviteInvalid: "Este enlace de invitación no es válido, caducó o fue anulado",
  transferFirst: "Eres el administrador: pasa ese papel a otro miembro antes de salir",
  cannotRemoveSelf: "No puedes quitarte a ti mismo; usa Salir",
  notMember: "Esa persona no es miembro de esta biblioteca",
  required: "No puede estar vacío",
  tooLong: (max: number) => `Como máximo ${max} caracteres`,
  badDomain: "No existe ese ámbito",
  needContent: "Escribe al menos una afirmación o un resumen",
  undoConflict: (n: number) => `${n === 1 ? "Un punto se volvió" : `${n} puntos se volvieron`} a cambiar después de este cambio; deshaz primero los cambios posteriores`,
  presets: {
    family: "Guardar: la situación y las preferencias de cada miembro de la familia (comida, alergias, horarios, tallas de ropa, etc.), salud y citas médicas, el colegio y las actividades de los niños, horarios y acuerdos familiares, las tiendas y servicios que usa la familia (limpieza, reparaciones, médicos), cómo funcionan los aparatos y cuentas de la casa (nunca contraseñas) y las decisiones tomadas en común.\nNo guardar: lo que solo atañe a una persona y no sirve a nadie más; trabajo; detalles puntuales; ninguna contraseña, código, número de documento o de tarjeta.",
    project: "Guardar: objetivos y alcance del proyecto, decisiones y sus motivos, convenciones (nombres, procesos, quién hace qué), procedimientos clave y errores a evitar, las personas y sistemas implicados, enlaces importantes.\nNo guardar: charla; detalles temporales que solo necesita una tarea; asuntos personales; ninguna clave, contraseña o token.",
    blank: "",
  },
};
