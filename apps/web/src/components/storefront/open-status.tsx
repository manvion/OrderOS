import { Badge } from '@/components/ui/primitives';

export function OpenStatus({ isOpen }: { isOpen: boolean }) {
  return (
    <Badge variant={isOpen ? 'success' : 'secondary'} className="shrink-0 gap-1.5 px-3 py-1">
      <span
        className={`h-2 w-2 rounded-full ${isOpen ? 'bg-emerald-600' : 'bg-muted-foreground'}`}
        aria-hidden
      />
      {isOpen ? 'Open now' : 'Closed'}
    </Badge>
  );
}
