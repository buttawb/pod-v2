import { StyleSheet, Text, View } from 'react-native';
import SignatureScreen from 'react-native-signature-canvas';
import { colors, spacing, type } from '../ui/theme';

/**
 * Renders the drawn signature to a PNG (base64), which the caller writes to
 * documentDirectory before any row references it.
 */
export function SignaturePad({
  onDone,
  onCancel,
}: {
  onDone: (base64Png: string) => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={type.heading}>Signature</Text>
        <Text style={type.small}>Ask the recipient to sign, then tap Save.</Text>
      </View>
      <SignatureScreen
        onOK={onDone}
        onEmpty={onCancel}
        descriptionText=""
        clearText="Clear"
        confirmText="Save"
        webStyle={WEB_STYLE}
      />
    </View>
  );
}

// The canvas is a WebView; these styles size its buttons for gloved hands.
const WEB_STYLE = `
  .m-signature-pad { box-shadow: none; border: none; }
  .m-signature-pad--body { border: 1px solid ${colors.border}; }
  .m-signature-pad--footer .button {
    background-color: ${colors.primary};
    color: #fff;
    font-size: 17px;
    min-height: 48px;
    border-radius: 10px;
  }
  .m-signature-pad--footer .button.clear { background-color: ${colors.surface}; color: ${colors.text}; }
  body, html { height: 100%; margin: 0; }
`;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { padding: spacing.md, gap: 2 },
});
