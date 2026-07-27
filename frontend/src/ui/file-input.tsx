/**
 * FileInput — native file control wrapper (ADR-0014 / nocx-dcsx).
 *
 * The platform draws the button's text in the browser's language — which is
 * why an English form showed a Russian "Выбор файла". This is native behaviour
 * and the trade ADR-0014 made deliberately.
 *
 * No `class` prop — identity is always `.ui-file-input` on the element.
 */
export interface FileInputProps {
  accept?: string
  onChange?: (file: File | null) => void
  disabled?: boolean
  ariaLabel?: string
}

export function FileInput(props: FileInputProps) {
  const onChange = (e: Event) => {
    const target = e.currentTarget as HTMLInputElement
    props.onChange?.(target.files?.[0] ?? null)
  }

  return (
    <input
      type="file"
      class="ui-file-input"
      accept={props.accept}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      onChange={onChange}
    />
  )
}
