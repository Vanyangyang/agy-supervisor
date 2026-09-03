# Third-party notices

This file lists third-party software included in the AGY Supervisor distribution (`plugins/agy-supervisor/dist/`), as determined from `package-lock.json` and an esbuild metafile of the production bundle.

AGY Supervisor itself is MIT-licensed. The notices below do not change that license and are not a claim of legal review.

Build-only dependency `esbuild` (MIT) and its optional platform packages are used to produce `dist/` and are **not** shipped inside the runtime bundles.

## Direct runtime dependencies

| Package | Version | License | Source |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT | https://www.npmjs.com/package/@modelcontextprotocol/sdk |
| `zod` | 4.4.3 | MIT | https://www.npmjs.com/package/zod |

## Transitive dependencies present in the dist bundle

These modules are pulled in by `@modelcontextprotocol/sdk` / `zod` and were observed in the esbuild metafile for `dist/agy-supervisor.mjs`. The daemon bundle (`dist/agy-supervisor-daemon.mjs`) contains only first-party scripts plus Node.js built-ins.

| Package | Version | License | Source |
| --- | --- | --- | --- |
| `ajv` | 8.20.0 | MIT | https://www.npmjs.com/package/ajv |
| `ajv-formats` | 3.0.1 | MIT | https://www.npmjs.com/package/ajv-formats |
| `fast-deep-equal` | 3.1.3 | MIT | https://www.npmjs.com/package/fast-deep-equal |
| `fast-uri` | 3.1.7 | BSD-3-Clause | https://www.npmjs.com/package/fast-uri |
| `json-schema-traverse` | 1.0.0 | MIT | https://www.npmjs.com/package/json-schema-traverse |
| `zod-to-json-schema` | 3.25.2 | ISC | https://www.npmjs.com/package/zod-to-json-schema |

Other packages listed in `package-lock.json` (for example Express, Hono, `jose`, `cors`) are install-time transitive dependencies of the MCP SDK. They were **not** present in the esbuild metafile for the current dist bundles and are therefore not redistributed by those bundles.

## License texts

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### ISC License

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

### BSD 3-Clause License

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.