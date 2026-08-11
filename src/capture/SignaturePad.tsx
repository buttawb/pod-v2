import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import SignatureScreen, { type SignatureViewRef } from 'react-native-signature-canvas';
import { BottomBar, Button, PageHeader, Screen, colors, radius, spacing } from '../ui/components';

/**
 * Renders the drawn signature to a PNG (base64), which the caller writes to
 * documentDirectory before any row references it.
 *
 * The pad's own HTML footer is hidden and the buttons are native: the WebView
 * lays its footer out against the full document height, so on a short screen
 * it ended up below the fold with no way to save a captured signature.
 */
export function SignaturePad({
  onDone,
  onCancel,
}: {
  onDone: (base64Png: string) => void;
  onCancel: () => void;
}) {
  const pad = useRef<SignatureViewRef>(null);

  return (
    <Screen>
      <PageHeader
        title="Signature"
        subtitle="Ask the recipient to sign, then tap Save"
        onBack={onCancel}
      />

      <View style={styles.canvas}>
        <SignatureScreen
          ref={pad}
          onOK={onDone}
          // Saving an untouched pad must not silently produce blank evidence.
          onEmpty={onCancel}
          descriptionText=""
          webStyle={WEB_STYLE}
        />
      </View>

      <BottomBar>
        <Button
          label="Save signature"
          icon="check"
          onPress={() => pad.current?.readSignature()}
        />
        <Button
          label="Clear"
          icon="rotate-ccw"
          variant="secondary"
          onPress={() => pad.current?.clearSignature()}
        />
      </BottomBar>
    </Screen>
  );
}

const WEB_STYLE = `
  .m-signature-pad { box-shadow: none; border: none; }
  .m-signature-pad--body { border: none; background: ${colors.background}; }
  .m-signature-pad--footer { display: none; }
  body, html { height: 100%; margin: 0; background: ${colors.background}; }
`;

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    margin: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.input,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
});
