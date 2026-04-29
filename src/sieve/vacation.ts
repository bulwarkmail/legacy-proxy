import type { SieveClient } from "./client.js";

export interface VacationProps {
  isEnabled: boolean;
  fromDate?: string | null;
  toDate?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}

const SCRIPT_NAME = "bulwark-vacation";

export function generateScript(v: VacationProps): string {
  const lines = ['require ["vacation"];', ""];
  if (!v.isEnabled) {
    return ['require ["vacation"];', "", "# vacation disabled", ""].join("\n");
  }
  const params: string[] = [":days 1"];
  if (v.subject) params.push(`:subject "${escape(v.subject)}"`);
  const body = v.textBody ?? "I am away.";
  lines.push(`vacation ${params.join(" ")} "${escape(body)}";`);
  return lines.join("\n");
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function readVacation(client: SieveClient): Promise<VacationProps> {
  const list = await client.listScripts();
  const ours = list.find((s) => s.name === SCRIPT_NAME);
  if (!ours) return { isEnabled: false };
  return { isEnabled: ours.active };
}

export async function writeVacation(client: SieveClient, v: VacationProps): Promise<void> {
  const body = generateScript(v);
  await client.putScript(SCRIPT_NAME, body);
  if (v.isEnabled) await client.setActive(SCRIPT_NAME);
}
