"""The raster API receives only the figure author's self-contained prompt."""


def image_prompt(item):
    prompt=item.get('_prompt')
    if not isinstance(prompt,str) or not prompt.strip():
        raise ValueError('image figure requires a self-contained _prompt')
    return prompt.strip()
