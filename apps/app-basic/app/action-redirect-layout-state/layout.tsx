import LayoutCounter from "./layout-counter";

export default function ActionRedirectLayoutStateLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <LayoutCounter />
      {children}
    </div>
  );
}
