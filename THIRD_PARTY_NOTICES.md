# Third-party notices

The optional integration facades and guidance formatting helpers adapt code from
[Supermemory](https://github.com/supermemoryai/supermemory), commit
`f81fad00e4bfc42610159cf6bd7bdb5fc4ca7cbe`:

- `packages/tools/src/openai/middleware.ts`: descriptor-preserving client facades
  and recovering the original client when rewrapping.
- `packages/tools/src/shared/memory-context.ts`: replacing marked context blocks
  while preserving application-authored instructions and escaping delimiters.
- `packages/openai-sdk-python/src/supermemory_openai/middleware.py`: isolated
  resource facades around a shared client.

The compatibility test matrix follows the packed-consumer testing approach in
`packages/tools/test/ai-sdk-compat/run.ts`. Execution persistence, lifecycle status,
stream observation, and feedback integration are Loopiter implementations.

## Supermemory license

MIT License

Copyright (c) 2025 Supermemory Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
