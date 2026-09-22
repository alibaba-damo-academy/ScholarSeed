import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'

import '../styles.css'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Drawer,
  DrawerPortal,
  DrawerTrigger,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  Progress,
  RadioGroup,
  RadioGroupItem,
  ResizablePanel,
  ScrollArea,
  ScrollBar,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetPortal,
  SheetTrigger,
  SonnerToaster,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  badgeVariants,
  buttonVariants,
  toggleVariants,
  useFormField
} from './ui'

function FormFieldPreview(): JSX.Element {
  const field = useFormField()
  return <output data-testid="compat-form-field-id">{field.id}</output>
}

function Fixture(): JSX.Element {
  const [otpValue, setOtpValue] = useState('135')
  const [selectValue, setSelectValue] = useState('quick')

  return (
    <main>
      <Alert data-testid="compat-alert">
        <AlertTitle>Alert title</AlertTitle>
        <AlertDescription>Alert description</AlertDescription>
      </Alert>
      <Avatar data-testid="compat-avatar">
        <AvatarImage alt="avatar" src="missing.png" />
        <AvatarFallback>AV</AvatarFallback>
      </Avatar>
      <Badge className={badgeVariants({ variant: 'secondary' })} data-testid="compat-badge" onRemove={() => undefined}>
        Removable
      </Badge>
      <Button className={buttonVariants({ variant: 'secondary' })}>Variant button</Button>
      <Form data-testid="compat-form">
        <FormField>
          <FormItem>
            <FormLabel>Compat field</FormLabel>
            <FormControl>
              <Input placeholder="field" />
            </FormControl>
            <FormFieldPreview />
          </FormItem>
        </FormField>
      </Form>
      <InputOTP label="Compat OTP">
        <InputOTPGroup>
          <InputOTPSlot index={0}>1</InputOTPSlot>
          <InputOTPSlot index={1}>2</InputOTPSlot>
        </InputOTPGroup>
        <InputOTPSeparator />
      </InputOTP>
      <InputOTP maxLength={3} value={otpValue} onChange={setOtpValue}>
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
      </InputOTP>
      <Dialog defaultOpen>
        <DialogContent hideCloseButton overlayProps={{ 'data-testid': 'compat-dialog-overlay' }}>
          <DialogTitle>Compat dialog props</DialogTitle>
          <DialogClose asChild>
            <button type="button">Close compat dialog</button>
          </DialogClose>
        </DialogContent>
      </Dialog>
      <Command>
        <CommandList>
          <CommandItem>
            <span>No value command</span>
          </CommandItem>
        </CommandList>
      </Command>
      <RadioGroup defaultValue="one">
        <RadioGroupItem value="one" aria-label="One" />
      </RadioGroup>
      <Progress title="Compat progress" subtitle="Migrated API" value={42} />
      <ResizablePanel
        leftPanel={<div>Left compat panel</div>}
        leftWidth="45%"
        rightPanel={<div>Right compat panel</div>}
      />
      <ScrollArea>
        <div>Scrollable</div>
        <ScrollBar />
      </ScrollArea>
      <Select value={selectValue} onValueChange={setSelectValue}>
        <SelectTrigger><SelectValue placeholder="Pick" /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Group</SelectLabel>
            <SelectItem value="quick">快速文献总结</SelectItem>
            <SelectItem value="deep">深度文献综述</SelectItem>
            <SelectSeparator />
            <SelectScrollUpButton>Up</SelectScrollUpButton>
            <SelectScrollDownButton>Down</SelectScrollDownButton>
          </SelectGroup>
        </SelectContent>
      </Select>
      <output data-testid="compat-select-value">{selectValue}</output>
      <Sheet>
        <SheetTrigger>Open sheet compat</SheetTrigger>
        <SheetPortal />
      </Sheet>
      <Drawer>
        <DrawerTrigger>Open drawer compat</DrawerTrigger>
        <DrawerPortal />
      </Drawer>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Tip trigger</TooltipTrigger>
          <TooltipContent>Tip content</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <SonnerToaster data-testid="compat-sonner" />
      <div data-testid="compat-toggle-class">{toggleVariants({ pressed: true })}</div>
      <CommandDialog>
        <Command>
          <CommandInput placeholder="Search" />
          <CommandList>
            <CommandItem value="save">Save <CommandShortcut>⌘S</CommandShortcut></CommandItem>
          </CommandList>
        </Command>
      </CommandDialog>
    </main>
  )
}

const localization = createLocalization('zh', resources, { escapeValue: false })
createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={localization}><Fixture /></I18nextProvider>)
