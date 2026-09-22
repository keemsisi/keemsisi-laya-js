/**
 * The Laya request/response contract.
 *
 * These mirror `@receptron/laya`'s published types (dist/types.d.ts), which
 * in turn follow the Python reference implementation's `RLAgent.system_one`
 * and TypeSafe Jev's `system_one` API. Laya is not a text generator: you
 * hand it a state and typed questions and it answers every one of them in a
 * single forward pass with calibrated probabilities.
 */

export type QuestionType = 'choice' | 'score' | 'noul';

/** Pick one option. `criteria` maps option -> description, or is a plain list. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string | object;
  criteria: Record<string, string | null> | string[];
}

/** Rate on an ordered rubric. `criteria[0]` is the lowest level. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string | object;
  criteria: string[];
}

/** A calibrated probability that a statement is true. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string | object;
  criteria?: { true?: string; false?: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

export interface RlAgentMeta {
  act_probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  /** 1 - normalized entropy of the distribution. Not the chosen option's probability. */
  confidence: number;
  rl_agent?: RlAgentMeta;
}

export interface ScoreAnswer {
  type: 'score';
  /** Expected level, 0 .. levels-1. Fractional. */
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
  rl_agent?: RlAgentMeta;
}

export interface NoulAnswer {
  type: 'noul';
  /** P(true) */
  noul: number;
  rl_agent?: RlAgentMeta;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Maps each question to the answer type it produces. */
export type AnswerFor<Q extends Question> =
  Q extends ChoiceQuestion ? ChoiceAnswer :
  Q extends ScoreQuestion ? ScoreAnswer :
  NoulAnswer;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResult<Q extends Questions = Questions> {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage?: Usage;
}

/** Anything the model is asked to read. Values are stringified for budgeting. */
export type State = Record<string, unknown> | string;
