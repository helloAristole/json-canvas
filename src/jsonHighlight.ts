import { json } from '@codemirror/lang-json'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

export function jsonLanguageExtensions(dark: boolean) {
  return [
    json(),
    syntaxHighlighting(
      HighlightStyle.define([
        {
          tag: tags.propertyName,
          color: dark ? '#7dcfff' : '#287b9b',
          fontWeight: '600',
        },
        {
          tag: tags.string,
          color: dark ? '#e0af68' : '#aa3f49',
        },
        {
          tag: tags.number,
          color: dark ? '#9ece6a' : '#16845b',
        },
        {
          tag: tags.bool,
          color: dark ? '#bb9af7' : '#7257f6',
        },
        {
          tag: tags.null,
          color: dark ? '#7a849e' : '#858b98',
          fontStyle: 'italic',
        },
        {
          tag: [tags.punctuation, tags.separator, tags.brace],
          color: dark ? '#6d768a' : '#656c79',
        },
        {
          tag: tags.escape,
          color: dark ? '#e8c07a' : '#a87413',
        },
        {
          tag: tags.invalid,
          color: dark ? '#ff7f8c' : '#d44e62',
          textDecoration: 'underline wavy',
        },
      ]),
    ),
  ]
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\]:,])/g

export function tokenizeJsonPreview(text: string) {
  const tokens: Array<{ className: string | null; text: string }> = []
  let last = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0
    if (index > last) tokens.push({ className: null, text: text.slice(last, index) })
    const [raw, key, string, number, keyword, punct] = match
    let className: string | null = 'json-hl-punct'
    if (key) className = 'json-hl-key'
    else if (string) className = 'json-hl-string'
    else if (number) className = 'json-hl-number'
    else if (keyword === 'null') className = 'json-hl-null'
    else if (keyword) className = 'json-hl-bool'
    else if (!punct) className = null
    tokens.push({ className, text: raw })
    last = index + raw.length
  }
  if (last < text.length) tokens.push({ className: null, text: text.slice(last) })
  return tokens
}
