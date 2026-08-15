import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectControlProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  menuClassName?: string;
  disabled?: boolean;
  name?: string;
  required?: boolean;
}

interface MenuPosition {
  side: "top" | "bottom";
  style: CSSProperties;
}

const VIEWPORT_GUTTER = 12;
const MENU_GAP = 8;
const MAX_MENU_HEIGHT = 320;

function enabledIndex(options: SelectOption[], start: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  for (let step = 1; step <= options.length; step += 1) {
    const index = (start + step * direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function edgeEnabledIndex(options: SelectOption[], fromEnd = false): number {
  const indexes = options.map((_, index) => index);
  if (fromEnd) indexes.reverse();
  return indexes.find((index) => !options[index]?.disabled) ?? -1;
}

function menuPosition(trigger: DOMRect): MenuPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const roomBelow = viewportHeight - trigger.bottom - MENU_GAP - VIEWPORT_GUTTER;
  const roomAbove = trigger.top - MENU_GAP - VIEWPORT_GUTTER;
  const side = roomBelow < 208 && roomAbove > roomBelow ? "top" : "bottom";
  const availableHeight = Math.max(96, side === "bottom" ? roomBelow : roomAbove);
  const width = Math.min(trigger.width, viewportWidth - VIEWPORT_GUTTER * 2);
  const left = Math.min(
    Math.max(VIEWPORT_GUTTER, trigger.left),
    viewportWidth - VIEWPORT_GUTTER - width,
  );
  const shared = {
    left,
    width,
    maxHeight: Math.min(MAX_MENU_HEIGHT, availableHeight),
  };
  return side === "bottom"
    ? { side, style: { ...shared, top: trigger.bottom + MENU_GAP } }
    : { side, style: { ...shared, bottom: viewportHeight - trigger.top + MENU_GAP } };
}

export function SelectControl({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  menuClassName = "",
  disabled = false,
  name,
  required = false,
}: SelectControlProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => {
    const selected = options.findIndex((option) => option.value === value && !option.disabled);
    return selected >= 0 ? selected : edgeEnabledIndex(options);
  });
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const blocked = disabled || options.length === 0;
  const portalTarget = triggerRef.current?.closest("dialog") ?? document.body;

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (trigger) setPosition(menuPosition(trigger.getBoundingClientRect()));
  };

  const openMenu = () => {
    if (blocked) return;
    const nextIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : edgeEnabledIndex(options);
    setActiveIndex(nextIndex);
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeMenu(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    const menu = menuRef.current;
    if (menu && typeof menu.showPopover === "function") {
      try { menu.showPopover(); } catch { /* Already open or unsupported by this browser. */ }
    }
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const dismissFromOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const dismissFromScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const reposition = () => updatePosition();
    document.addEventListener("pointerdown", dismissFromOutside, true);
    document.addEventListener("scroll", dismissFromScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", dismissFromOutside, true);
      document.removeEventListener("scroll", dismissFromScroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const active = document.getElementById(`${id}-option-${activeIndex}`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (blocked) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      if (open) closeMenu();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((current) => enabledIndex(options, current, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) openMenu();
      setActiveIndex(edgeEnabledIndex(options, event.key === "End"));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) commit(activeIndex);
      else openMenu();
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      typeaheadRef.current += event.key.toLocaleLowerCase();
      if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = window.setTimeout(() => { typeaheadRef.current = ""; }, 650);
      const match = options.findIndex((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeaheadRef.current));
      if (match >= 0) {
        if (!open) openMenu();
        setActiveIndex(match);
      }
    }
  };

  const stopPortalLabelClick = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  return (
    <div className={`select-control${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={triggerRef}
        type="button"
        className="select-control__trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={`${id}-listbox`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-required={required || undefined}
        disabled={blocked}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className="select-control__value" title={selected?.label}>{selected?.label ?? "—"}</span>
        <svg className="select-control__chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          id={`${id}-listbox`}
          className={`select-control__menu${menuClassName ? ` ${menuClassName}` : ""}`}
          role="listbox"
          aria-label={ariaLabel}
          data-side={position.side}
          style={position.style}
          popover="manual"
          onPointerDown={stopPortalLabelClick}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <button
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`select-control__option${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
                disabled={option.disabled}
                key={option.value}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onClick={(event) => {
                  event.stopPropagation();
                  commit(index);
                }}
              >
                <span>{option.label}</span>
                {isSelected && (
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3 3 7-7" /></svg>
                )}
              </button>
            );
          })}
        </div>,
        portalTarget,
      )}
    </div>
  );
}
