import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'

import '../styles.css'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Calendar,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  Chart,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger
} from './ui'

function Fixture(): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [alertDialogOpen, setAlertDialogOpen] = useState(false)
  const [alertDialogResult, setAlertDialogResult] = useState('pending')
  const [dropdownValue, setDropdownValue] = useState('')
  const [contextValue, setContextValue] = useState('')
  const [menubarValue, setMenubarValue] = useState('')
  const [calendarDay, setCalendarDay] = useState(0)
  const [hoverCardValue, setHoverCardValue] = useState('pending')

  return (
    <main>
      <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent aria-label="Dialog title">
          <DialogHeader>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialog body</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>Close dialog</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button onClick={() => setAlertDialogOpen(true)}>Open alert dialog</Button>
      <AlertDialog open={alertDialogOpen} onOpenChange={setAlertDialogOpen}>
        <AlertDialogContent aria-label="Delete project">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>This action needs confirmation.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel delete</AlertDialogCancel>
            <AlertDialogAction onClick={() => setAlertDialogResult('deleted')}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <span data-testid="render-alert-dialog-result">{alertDialogResult}</span>

      <Popover>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent data-testid="render-popover-content">Popover content</PopoverContent>
      </Popover>

      <HoverCard>
        <HoverCardTrigger data-testid="render-hover-card-trigger">Hover card</HoverCardTrigger>
        <HoverCardContent data-testid="render-hover-card-content">
          Hover details
          <Button onClick={() => setHoverCardValue('opened')}>Open hover detail</Button>
        </HoverCardContent>
      </HoverCard>
      <output data-testid="render-hover-card-value">{hoverCardValue}</output>

      <DropdownMenu>
        <DropdownMenuTrigger>Open dropdown</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setDropdownValue('Archive')}>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <output data-testid="render-dropdown-value">{dropdownValue}</output>

      <ContextMenu>
        <ContextMenuTrigger data-testid="render-context-menu-trigger">Context target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setContextValue('Duplicate')}>Duplicate</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <output data-testid="render-context-menu-value">{contextValue}</output>

      <Menubar>
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onSelect={() => setMenubarValue('New')}>New</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <output data-testid="render-menubar-value">{menubarValue}</output>

      <NavigationMenu>
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger>Docs</NavigationMenuTrigger>
            <NavigationMenuContent data-testid="render-navigation-menu-content">Guide</NavigationMenuContent>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>

      <Carousel defaultIndex={0}>
        <CarouselContent data-testid="render-carousel-active-slide">
          <CarouselItem>First</CarouselItem>
          <CarouselItem>Second</CarouselItem>
        </CarouselContent>
        <CarouselPrevious>Previous slide</CarouselPrevious>
        <CarouselNext>Next slide</CarouselNext>
      </Carousel>

      <Calendar selectedDay={calendarDay} onSelectDay={setCalendarDay} />
      <output data-testid="render-calendar-value">{calendarDay}</output>

      <Chart
        data={[
          { label: 'A', value: 10 },
          { label: 'B', value: 20 }
        ]}
        data-testid="render-chart"
      />
    </main>
  )
}

const localization = createLocalization('zh', resources, { escapeValue: false })
createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={localization}><Fixture /></I18nextProvider>)
