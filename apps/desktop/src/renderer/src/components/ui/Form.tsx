import type { HTMLAttributes, ReactElement, ReactNode } from 'react'
import { Children, cloneElement, createContext, forwardRef, isValidElement, useContext, useId } from 'react'

import { formDescriptionClassName, formFieldClassName, formMessageClassName } from './classes'
import { Label, type LabelProps } from './Label'

interface FieldContextValue {
  controlId: string
  descriptionId?: string
  id: string
  messageId?: string
}

const FieldContext = createContext<FieldContextValue | null>(null)

function useFieldContext(componentName: string): FieldContextValue {
  const context = useContext(FieldContext)
  if (!context) throw new Error(`${componentName} must be used within FormField`)
  return context
}

export function useFormField(): FieldContextValue {
  return useContext(FieldContext) ?? { controlId: '', id: '' }
}

function hasFormChild(children: ReactNode, component: unknown): boolean {
  return Children.toArray(children).some((child) => (
    isValidElement<{ children?: ReactNode }>(child) && (
      child.type === component || hasFormChild(child.props.children, component)
    )
  ))
}

export interface FormFieldProps extends HTMLAttributes<HTMLDivElement> {
  id?: string
}

export const FormField = forwardRef<HTMLDivElement, FormFieldProps>(
  ({ children, className, id, ...props }, ref) => {
    const generatedId = useId()
    const fieldId = id ?? generatedId
    const context: FieldContextValue = {
      controlId: `${fieldId}-control`,
      descriptionId: hasFormChild(children, FormDescription) ? `${fieldId}-description` : undefined,
      id: fieldId,
      messageId: hasFormChild(children, FormMessage) ? `${fieldId}-message` : undefined
    }

    return (
      <FieldContext.Provider value={context}>
        <div className={formFieldClassName({ className })} ref={ref} {...props}>
          {children}
        </div>
      </FieldContext.Provider>
    )
  }
)

FormField.displayName = 'FormField'

export const Field = FormField

export type FormProps = HTMLAttributes<HTMLFormElement>

export const Form = forwardRef<HTMLFormElement, FormProps>(({ className, ...props }, ref) => (
  <form className={['vds-form', className].filter(Boolean).join(' ')} ref={ref} {...props} />
))

Form.displayName = 'Form'

export type FormItemProps = HTMLAttributes<HTMLDivElement>

export const FormItem = forwardRef<HTMLDivElement, FormItemProps>(({ className, ...props }, ref) => (
  <div className={['vds-form-field__item', className].filter(Boolean).join(' ')} ref={ref} {...props} />
))

FormItem.displayName = 'FormItem'

export type FormLabelProps = Omit<LabelProps, 'htmlFor'>

export function FormLabel(props: FormLabelProps): JSX.Element {
  const { controlId } = useFieldContext('FormLabel')
  return <Label htmlFor={controlId} {...props} />
}

export interface FormControlProps {
  children: ReactElement<{
    'aria-describedby'?: string
    'aria-invalid'?: boolean
    id?: string
  }>
  invalid?: boolean
}

export function FormControl({ children, invalid = false }: FormControlProps): JSX.Element {
  const { controlId, descriptionId, messageId } = useFieldContext('FormControl')
  const describedBy = [children.props['aria-describedby'], descriptionId, messageId].filter(Boolean).join(' ')
  return cloneElement(children, {
    'aria-describedby': describedBy || undefined,
    'aria-invalid': invalid || children.props['aria-invalid'] || undefined,
    id: children.props.id ?? controlId
  })
}

export type FormDescriptionProps = HTMLAttributes<HTMLParagraphElement>

export const FormDescription = forwardRef<HTMLParagraphElement, FormDescriptionProps>(
  ({ className, ...props }, ref) => {
    const { descriptionId } = useFieldContext('FormDescription')
    if (!descriptionId) throw new Error('FormDescription must be a descendant of FormField')
    return <p className={formDescriptionClassName({ className })} id={descriptionId} ref={ref} {...props} />
  }
)

FormDescription.displayName = 'FormDescription'

export type FormMessageProps = HTMLAttributes<HTMLParagraphElement>

export const FormMessage = forwardRef<HTMLParagraphElement, FormMessageProps>(
  ({ className, ...props }, ref) => {
    const { messageId } = useFieldContext('FormMessage')
    if (!messageId) throw new Error('FormMessage must be a descendant of FormField')
    return <p aria-live="polite" className={formMessageClassName({ className })} id={messageId} ref={ref} {...props} />
  }
)

FormMessage.displayName = 'FormMessage'
