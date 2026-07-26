import { Laptop, Moon, Palette, Sun } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/theme-provider";
import { accents, appearances, type Appearance } from "@/lib/theme";

const appearanceLabels: Record<Appearance, { label: string; icon: typeof Sun }> = {
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
  system: { label: "System", icon: Laptop },
};

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function ThemeMenu() {
  const { accent, appearance, setAccent, setAppearance } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Change appearance and accent">
          <Palette />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={appearance}
          onValueChange={(value) => setAppearance(value as Appearance)}
        >
          {appearances.map((value) => {
            const Icon = appearanceLabels[value].icon;
            return (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon className="mr-2 size-3.5" />
                {appearanceLabels[value].label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Accent</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={accent}
          onValueChange={(value) => setAccent(value as typeof accent)}
        >
          {accents.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <span
                className="mr-2 size-3.5 rounded-full bg-primary ring-1 ring-foreground/10"
                data-preview-accent={value}
              />
              {titleCase(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
