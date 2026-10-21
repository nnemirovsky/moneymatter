import { useUserSettings } from '@/composable/data-queries/user-settings';
import { TRANSACTION_OPTIONAL_FIELDS, type TransactionOptionalField } from '@bt/shared/types';
import { computed } from 'vue';

// Applies only until the user saves the setting once; an explicit empty list stays empty.
const DEFAULT_OPTIONAL_FIELDS: TransactionOptionalField[] = [...TRANSACTION_OPTIONAL_FIELDS];

/**
 * Read/write access to the per-user "optional transaction fields" preference. The transaction form
 * offers an "add" chip for each field enabled here; a field that already holds a value always renders.
 */
export const useOptionalFields = () => {
  const { data: userSettings, patchAsync, isPatching } = useUserSettings();

  const enabled = computed<TransactionOptionalField[]>(
    () => userSettings.value?.ui?.transactionForm?.optionalFields ?? DEFAULT_OPTIONAL_FIELDS,
  );

  const isEnabled = (field: TransactionOptionalField) => enabled.value.includes(field);

  const setEnabled = ({ field, value }: { field: TransactionOptionalField; value: boolean }) =>
    patchAsync({
      ui: {
        transactionForm: {
          optionalFields: value ? [...enabled.value, field] : enabled.value.filter((f) => f !== field),
        },
      },
    });

  return { isEnabled, setEnabled, isUpdating: isPatching };
};
