import { DatabaseSync } from 'node:sqlite';
export class QuestionError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export function parseQuestionInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['question', 'choices'].includes(key))) throw new QuestionError(400, 'Invalid question or choices.');
  const input = value as Record<string, unknown>, question = input.question, choices = input.choices;
  if (typeof question !== 'string' || !question.trim() || question.length > 2000 || !Array.isArray(choices) || choices.length > 8 || choices.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 200) || new Set(choices.map(choice => String(choice).trim())).size !== choices.length) throw new QuestionError(400, 'Invalid question or choices.');
  return { question: question.trim(), choices: choices.map(choice => String(choice).trim()) };
}
export function initializeQuestions(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,call TEXT NOT NULL,prompt TEXT NOT NULL,choices TEXT NOT NULL,answer TEXT,after_output INTEGER NOT NULL,after_action INTEGER NOT NULL,UNIQUE(turn,call_id)) STRICT;
    CREATE TABLE IF NOT EXISTS question_answers(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;`);
}
export function turnQuestions(db: DatabaseSync, turn: string) {
  return db.prepare('SELECT id,prompt,choices,answer FROM questions WHERE turn=? ORDER BY rowid').all(turn).map(row => ({ id: String(row.id), prompt: String(row.prompt), answer: row.answer === null ? null : String(row.answer), choices: JSON.parse(String(row.choices)) as string[] }));
}
