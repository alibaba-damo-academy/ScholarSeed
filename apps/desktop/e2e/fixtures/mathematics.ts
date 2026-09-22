export const MATHEMATICS_SOURCE = String.raw`# Rendering acceptance

INLINE: $x_i^2 + \frac{a}{b} + \sqrt{x}$.

PLAIN: body text keeps the reference line height.

PAREN: \(\sum_{i=1}^{n} i^2\).

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

\[
\begin{pmatrix} a & b \\ c & d \end{pmatrix}
\]

UNKNOWN: $\unknowncommand{x}$.

INVALID: $\frac{a$.

CODE: \`$x_i$ \(x^2\)\`.

\`\`\`markdown
$$\frac{a}{b}$$
\[x^2\]
\`\`\`

\`\`\`latex
\frac{a}{b} + \sqrt{x}
\`\`\`

| Column | Value |
| --- | --- |
| Formula | $a_1$ |

![fixture](acceptance.png)

`.replaceAll('\\`', '`') + Array.from({ length: 80 }, (_, index) => `## Section ${index + 1}\n\nLong paragraph ${index + 1}: scroll without moving the caret.\n\n`).join('') + '\nDOCUMENT END\n'
