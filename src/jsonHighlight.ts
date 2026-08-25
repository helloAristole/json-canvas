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
