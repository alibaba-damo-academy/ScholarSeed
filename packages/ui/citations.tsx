import React from 'react'
import {
  CitationLink as FileCitation,
  WebCitationLink as WebCitation,
} from '../../apps/desktop/src/renderer/src/components/business/Citation'

type CitationProps =
  React.ComponentProps<typeof FileCitation> | React.ComponentProps<typeof WebCitation>

export function CitationLink(props: CitationProps): React.JSX.Element {
  return 'source' in props ? <WebCitation {...props} /> : <FileCitation {...props} />
}
