import { splitMapBlocks, type MessagePart } from "./mapBlocks";
import { splitSvgBlocks, type SvgPart } from "./svgBlocks";
import { splitMermaidBlocks, type MermaidPart } from "./mermaidBlocks";
import { splitAskBlocks, splitChoiceBlocks, splitFormBlocks, type AskPart, type ChoicePart, type FormPart } from "./choices";
import { splitProductBlocks, type ProductPart } from "./productBlocks";
import { splitCameraBlocks, type CameraPart } from "./cameraBlocks";
import { splitChartBlocks, type ChartPart } from "./chartBlocks";

/** One piece of a message: Markdown text or one of the fenced blocks drawn as a card. */
export type MessagePiece = MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart | AskPart | FormPart | CameraPart | ChartPart;

/**
 * Split a message into Markdown text and its fenced blocks, in order. Rendering
 * (Markdown.tsx) and copying (replyText.ts) both use this, so a block type added
 * here is seen by both.
 */
export function splitMessageParts(source: string): MessagePiece[] {
  return splitMapBlocks(source)
    .flatMap<MessagePart | SvgPart>((part) => (part.kind === "text" ? splitSvgBlocks(part.text) : [part]))
    .flatMap<MessagePart | SvgPart | MermaidPart>((part) => (part.kind === "text" ? splitMermaidBlocks(part.text) : [part]))
    .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart>((part) => (part.kind === "text" ? splitChoiceBlocks(part.text) : [part]))
    .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart>((part) => (part.kind === "text" ? splitProductBlocks(part.text) : [part]))
    .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart | AskPart>((part) => (part.kind === "text" ? splitAskBlocks(part.text) : [part]))
    .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart | AskPart | FormPart>((part) => (part.kind === "text" ? splitFormBlocks(part.text) : [part]))
    .flatMap<MessagePart | SvgPart | MermaidPart | ChoicePart | ProductPart | AskPart | FormPart | CameraPart>((part) => (part.kind === "text" ? splitCameraBlocks(part.text) : [part]))
    .flatMap<MessagePiece>((part) => (part.kind === "text" ? splitChartBlocks(part.text) : [part]));
}
