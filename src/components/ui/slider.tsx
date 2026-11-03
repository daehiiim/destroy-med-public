import * as React from "react"
import { cn } from "cn"
import { Slider as SliderPrimitive } from "radix-ui"

// 값 하나를 끌어서 고르는 가로 슬라이더. 루트 높이를 44px로 잡아 터치로도 잡기 쉽게 한다
// aria-label은 화면 읽기 프로그램이 읽는 손잡이(role=slider)에 붙인다
function Slider({ className, "aria-label": label, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex h-11 w-full touch-none items-center select-none data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className="relative h-1.5 grow overflow-hidden rounded-full bg-input">
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={label}
        className="block size-4 shrink-0 rounded-full bg-white shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
