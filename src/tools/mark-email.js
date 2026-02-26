/**
 * mark-email.js — Ferramenta MCP para marcar e-mail como lido ou não lido
 */

import { z } from "zod";
import { graphRequest } from "../graph.js";

export const markEmailSchema = z.object({
  id: z.string().describe("ID do e-mail (obtido via ler_emails)"),
  lido: z.boolean().describe("true = marcar como lido | false = marcar como não lido"),
});

export async function markEmail(params) {
  const { id, lido } = params;

  await graphRequest("PATCH", `/me/messages/${id}`, { isRead: lido });

  return `E-mail ${id} marcado como ${lido ? "lido" : "não lido"}.`;
}
