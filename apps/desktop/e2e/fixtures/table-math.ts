export const TABLE_MATH_SOURCE = String.raw`# Table and math interaction

Move the table below the sticky toolbar so every outer boundary remains directly operable.

The fixture exercises empty cells together with 中文长文本 and long English content.

| 左侧中文长标题 | Middle column with long English text | 末列 |
| :--- | :---: | ---: |
| 左侧内容需要保持顺序 | Middle content must remain unchanged | 末列内容 |
|  |  |  |

$$
x_1^2 + \frac{a}{b}
$$

Second formula:

$$
\int_0^1 x^2\,dx
$$

\`\`\`markdown
$$not-rendered$$
\`\`\`

\`\`\`latex
\frac{code}{only}
\`\`\`

`.replaceAll('\\`', '`') + Array.from({ length: 30 }, (_, index) => `## Long section ${index + 1}\n\nLong document content ${index + 1}.\n\n`).join('')
