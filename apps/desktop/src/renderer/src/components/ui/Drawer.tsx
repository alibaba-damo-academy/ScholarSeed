import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { forwardRef } from 'react'

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
  type SheetCloseProps,
  type SheetContentProps,
  type SheetDescriptionProps,
  type SheetFooterProps,
  type SheetHeaderProps,
  type SheetOverlayProps,
  type SheetProps,
  type SheetSide,
  type SheetTitleProps
} from './Sheet'
import { drawerClassName, drawerStyleClassName } from './classes'
import { cx } from './utils'

export type DrawerDirection = SheetSide
export type DrawerProps = SheetProps
export type DrawerOverlayProps = SheetOverlayProps
export interface DrawerContentProps extends Omit<SheetContentProps, 'side'> {
  direction?: DrawerDirection
  side?: DrawerDirection
}
export type DrawerHeaderProps = SheetHeaderProps
export type DrawerFooterProps = SheetFooterProps
export type DrawerTitleProps = SheetTitleProps
export type DrawerDescriptionProps = SheetDescriptionProps
export type DrawerCloseProps = SheetCloseProps

export const Drawer = Sheet
export const DrawerOverlay = SheetOverlay
export const DrawerHeader = SheetHeader
export const DrawerFooter = SheetFooter
export const DrawerTitle = SheetTitle
export const DrawerDescription = SheetDescription
export const DrawerClose = SheetClose
export const DrawerPortal = SheetPortal
export const DrawerTrigger = SheetTrigger

export const DrawerContent = forwardRef<ElementRef<typeof SheetContent>, DrawerContentProps>(
  ({ className, direction, side, ...props }, ref) => {
    const currentSide = direction ?? side ?? 'bottom'

    return (
      <SheetContent
        className={cx(drawerClassName({ side: currentSide }), drawerStyleClassName({ side: currentSide }), className)}
        ref={ref}
        side={currentSide}
        {...props}
      />
    )
  }
)

DrawerContent.displayName = 'DrawerContent'

export type DrawerRootProps = ComponentPropsWithoutRef<typeof Drawer>
