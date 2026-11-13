/**
 * Copyright 2018 Zhilin Yang, Peng Qi, Saizheng Zhang
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified TypeScript port of hotpot_evaluate_v1.py from
 * https://github.com/hotpotqa/hotpot/blob/3635853403a8735609ee997664e1528f4480762a/hotpot_evaluate_v1.py
 * The repository license is Apache-2.0 (LICENSE.txt at that commit).
 * See benchmarks/NOTICE.
 */

const PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

export function normalizeAnswer(value: string): string {
  const lowered = value.toLowerCase();
  const withoutPunctuation = [...lowered].filter((character) => !PUNCTUATION.has(character)).join("");
  const withoutArticles = withoutPunctuation.replace(/\b(a|an|the)\b/g, " ");
  return withoutArticles.split(/\s+/).filter((token) => token.length > 0).join(" ");
}

export function exactMatch(prediction: string, groundTruth: string): boolean {
  return normalizeAnswer(prediction) === normalizeAnswer(groundTruth);
}

export function tokenF1(prediction: string, groundTruth: string): number {
  const normalizedPrediction = normalizeAnswer(prediction);
  const normalizedGroundTruth = normalizeAnswer(groundTruth);
  if (
    (normalizedPrediction === "yes" ||
      normalizedPrediction === "no" ||
      normalizedPrediction === "noanswer") &&
    normalizedPrediction !== normalizedGroundTruth
  )
    return 0;
  if (
    (normalizedGroundTruth === "yes" ||
      normalizedGroundTruth === "no" ||
      normalizedGroundTruth === "noanswer") &&
    normalizedPrediction !== normalizedGroundTruth
  )
    return 0;
  const predictionTokens = normalizedPrediction.length === 0 ? [] : normalizedPrediction.split(" ");
  const groundTruthTokens =
    normalizedGroundTruth.length === 0 ? [] : normalizedGroundTruth.split(" ");
  const common = new Map<string, number>();
  for (const token of predictionTokens) common.set(token, (common.get(token) ?? 0) + 1);
  let shared = 0;
  const used = new Map<string, number>();
  for (const token of groundTruthTokens) {
    const available = (common.get(token) ?? 0) - (used.get(token) ?? 0);
    if (available > 0) {
      shared += 1;
      used.set(token, (used.get(token) ?? 0) + 1);
    }
  }
  if (shared === 0) return 0;
  const precision = shared / predictionTokens.length;
  const recall = shared / groundTruthTokens.length;
  return (2 * precision * recall) / (precision + recall);
}
