import { Search } from 'lucide-react'
import { forwardRef, type InputHTMLAttributes } from 'react'

import { Input, type InputSize } from './Input'
import { cx } from './utils'

export interface SearchBoxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  containerClassName?: string
  size?: InputSize
}

const SEARCH_BOX_CLASS_NAME = 'relative min-w-0 [&>label]:block [&_input]:pl-[var(--vds-space-8)] [&_input::-webkit-search-cancel-button]:hidden'

export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(
  ({ className, containerClassName, size = 'md', ...props }, ref) => (
    <div className={cx(SEARCH_BOX_CLASS_NAME, containerClassName)}>
      <Search aria-hidden className="pointer-events-none absolute left-[var(--vds-space-3)] top-1/2 z-[var(--vds-z-local-raised)] size-4 -translate-y-1/2 text-[var(--vds-text-tertiary)]" />
      <Input {...props} className={className} ref={ref} size={size} type="search" />
    </div>
  )
)

SearchBox.displayName = 'SearchBox'
