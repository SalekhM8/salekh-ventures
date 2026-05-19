type SectionHeaderProps = {
  left: string;
  center: string;
  right: string;
};

export function SectionHeader({ left, center, right }: SectionHeaderProps) {
  return (
    <div className="mb-16 grid grid-cols-3 items-baseline text-xs uppercase tracking-[0.2em] text-muted md:mb-24">
      <span>{left}</span>
      <span className="text-center">{center}</span>
      <span className="text-right">{right}</span>
    </div>
  );
}
