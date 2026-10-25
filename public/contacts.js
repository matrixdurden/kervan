// Telefon rehberinden kişi seçme (Contact Picker API). Şimdilik sadece Android'deki Chrome
// destekliyor; iPhone'da ve bilgisayarda düğme hiç gösterilmez, ad ve numara elle yazılır.

export const canPickContact = () => "contacts" in navigator && "ContactsManager" in window;

// { name, phone } ya da vazgeçilirse null.
export async function pickContact() {
  const [contact] = await navigator.contacts.select(["name", "tel"], { multiple: false });
  if (!contact) return null;
  return { name: contact.name?.[0]?.trim() ?? "", phone: contact.tel?.[0]?.trim() ?? "" };
}
